import io
import json
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import select

from simple_annotator.db import session_factory
from simple_annotator.models import Patch, Slide

# Thumbnails are 800 x 600 with one tissue disk of radius 80 centred at (150, 150).
IMAGES = {
    "histo": {"sizeX": 8000, "sizeY": 6000, "mm_x": 0.00025},
    "big": {"sizeX": 40000, "sizeY": 30000, "mm_x": 0.00025},
    "gray": {"sizeX": 4200, "sizeY": 4200, "mm_x": 0.00025},
    "small": {"sizeX": 900, "sizeY": 700},
}


def _png(item_id: str) -> bytes:
    rgb = np.full((600, 800, 3), 245, np.uint8)
    cv2.circle(rgb, (150, 150), 80, (200, 90, 160), -1)
    if item_id == "gray":
        rgb = np.repeat(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)[..., None], 3, axis=2)
    out = io.BytesIO()
    Image.fromarray(rgb).save(out, format="PNG")
    return out.getvalue()


@pytest.fixture
def girder(auth: TestClient, monkeypatch):
    from simple_annotator import images, patches, slides

    items = [{"_id": "histo", "name": "slide.svs"}]
    monkeypatch.setattr(slides, "girder_enabled", lambda: True)
    monkeypatch.setattr(images, "girder_enabled", lambda: True)
    monkeypatch.setattr(images, "folder_images", lambda _: list(items))
    monkeypatch.setattr(slides, "image_info", lambda item: (IMAGES[item], ""))
    monkeypatch.setattr(slides, "thumbnail", lambda item, _: _png(item))
    monkeypatch.setattr(patches, "thumbnail", lambda item, _: _png(item))
    monkeypatch.setattr(slides, "is_elmi_folder", lambda _: False)
    auth.patch("/me", json={"last_folder_id": "dataset"})
    return items


def _walk(client: TestClient, n: int) -> list[dict]:
    return [client.get("/patches/next").json() for _ in range(n)]


def test_histology_patch_is_the_padded_tissue_region_with_slide_view(auth, girder):
    patch = auth.get("/patches/current").json()
    assert patch["nm_per_px"] == 250
    image = patch["image"]
    # The disk spans slide pixels 700..2300; 250 µm of padding is 1000 px, clamped at 0.
    assert (image["left"], image["top"]) == (0, 0)
    assert 3300 <= image["width"] <= 3400 and 3300 <= image["height"] <= 3400
    assert (image["slide_width"], image["levels"]) == (8000, 6)
    slide = patch["slide"]
    assert [t[:4] for t in slide["tiles"]] == [[0, 0, image["width"], image["height"]]]
    assert slide["tiles"][slide["current"]][4] is True
    assert auth.get(f"/patches/{patch['id']}/slide-thumbnail").content == _png("histo")


def test_tiles_pass_through_for_the_patch_item(auth, girder, monkeypatch):
    from simple_annotator import patches

    monkeypatch.setattr(patches, "tile", lambda *args: (repr(args).encode(), "image/jpeg"))
    patch = auth.get("/patches/current").json()
    url = patch["image"]["tile_url"].format(z=3, x=1, y=2)
    response = auth.get(url)
    assert response.content == b"('histo', 3, 1, 2)"
    assert response.headers["content-type"] == "image/jpeg"


def test_large_regions_prepare_ai_tiles_around_the_view(auth, girder):
    from simple_annotator.models import AiEmbedding

    girder[0] = {"_id": "big", "name": "big.svs"}
    patch = auth.get("/patches/current").json()
    assert patch["image"]["width"] > 4096
    with session_factory()() as db:
        assert db.scalars(select(AiEmbedding)).all() == []
    whole = {"left": 0, "top": 0, "width": patch["image"]["width"], "height": 9000}
    assert auth.post(f"/patches/{patch['id']}/prepare", json=whole).status_code == 200
    with session_factory()() as db:
        assert db.scalars(select(AiEmbedding)).all() == []
    view = {"left": 0, "top": 0, "width": 1000, "height": 1000}
    assert auth.post(f"/patches/{patch['id']}/prepare", json=view).status_code == 200
    with session_factory()() as db:
        assert len(db.scalars(select(AiEmbedding)).all()) == 1


def _three_images(girder: list[dict]) -> None:
    girder[:] = [
        {"_id": "histo", "name": "a.svs", "folder_name": "zz", "meta": {"staining": "PAS"}},
        {"_id": "gray", "name": "b.tif", "meta": {"case_id": "case-10", "staining": "HE"}},
        {"_id": "small", "name": "c.png", "meta": {"case_id": "case-2", "staining": "PAS"}},
    ]


def _at(patch: dict) -> tuple[str, int]:
    return patch["item_id"], patch["slide"]["current"] if patch["slide"] else 0


def test_next_walks_regions_then_images_in_case_order_and_wraps(auth, girder):
    _three_images(girder)
    walk = [_at(p) for p in [auth.get("/patches/current").json(), *_walk(auth, 39)]]
    gray = [("gray", i) for i in range(36)]
    assert walk == [("small", 0), *gray, ("histo", 0), ("small", 0), ("gray", 0)]
    back = [_at(auth.get("/patches/prev").json()) for _ in range(4)]
    assert back == [("small", 0), ("histo", 0), ("gray", 35), ("gray", 34)]


def test_stain_filter_skips_other_images(auth, girder):
    _three_images(girder)
    auth.patch("/me", json={"stain_filter": ["PAS"]})
    walk = [_at(p) for p in [auth.get("/patches/current").json(), *_walk(auth, 2)]]
    assert walk == [("small", 0), ("histo", 0), ("small", 0)]
    auth.patch("/me", json={"stain_filter": ["IgG", None]})
    response = auth.get("/patches/next")
    assert response.status_code == 400
    assert response.json()["detail"] == "No images in this dataset match the stain filter."


def test_open_image_starts_at_its_first_unvisited_region(auth, girder):
    _three_images(girder)
    opened = auth.post("/patches/open", json={"item_id": "gray"}).json()
    assert _at(opened) == ("gray", 0)
    assert _at(auth.get("/patches/next").json()) == ("gray", 1)
    auth.post("/patches/open", json={"item_id": "small"})
    assert _at(auth.post("/patches/open", json={"item_id": "gray"}).json()) == ("gray", 2)
    assert auth.post("/patches/open", json={"item_id": "elsewhere"}).status_code == 404


def test_next_skips_a_current_image_that_became_unreadable(auth, girder, monkeypatch):
    from simple_annotator import slides

    _three_images(girder)
    assert _at(auth.get("/patches/current").json()) == ("small", 0)
    with session_factory()() as db:
        db.delete(db.get(Slide, "small"))
        db.commit()
    ok = slides.image_info
    monkeypatch.setattr(slides, "image_info", lambda i: (None, "gone") if i == "small" else ok(i))
    assert _at(auth.get("/patches/next").json()) == ("gray", 0)


def test_empty_dataset_is_a_clear_400_everywhere(auth, girder, monkeypatch):
    from simple_annotator import images

    def empty(_):
        raise RuntimeError("This dataset contains no images.")

    monkeypatch.setattr(images, "folder_images", empty)
    for response in [auth.get("/images"), auth.post("/patches/open", json={"item_id": "x"})]:
        assert response.status_code == 400
        assert response.json()["detail"] == "This dataset contains no images."


def test_image_list_groups_by_case_with_stains_and_progress(auth, girder):
    _three_images(girder)
    girder[1]["meta"]["image_magnification"] = 412.31209375
    girder[2]["meta"]["image_magnification"] = 206.156046875
    auth.get("/patches/current")
    auth.post("/patches/open", json={"item_id": "gray"})
    auth.get("/patches/next")
    listing = auth.get("/images").json()
    rows = [
        (r["id"], r["group"], r["staining"], r["magnification"], r["regions"], r["visited"])
        for r in listing["items"]
    ]
    assert rows == [
        ("small", "case-2", "PAS", 20, 1, 1),
        ("gray", "case-10", "HE", 40, 36, 2),
        ("histo", "zz", "PAS", None, None, 0),
    ]
    assert listing["stains"] == [{"name": "PAS", "count": 2}, {"name": "HE", "count": 1}]


def test_users_walk_shared_tiles_row_by_row_with_own_annotations(auth, client, girder):
    girder[0] = {"_id": "gray", "name": "gray.tif"}
    ada = _walk(auth, 36)
    with session_factory()() as db:
        origins = [(db.get(Patch, p["id"]).top, db.get(Patch, p["id"]).left) for p in ada]
    assert origins == sorted(origins) and len(set(origins)) == 36
    element = {"id": "dot", "jobId": 1, "type": "point", "points": [[5.0, 5.0]]}
    auth.patch(f"/patches/{ada[0]['id']}/annotations", json={"upsert": [element]})
    client.post("/auth/register", json={"username": "bob", "password": "secret"})
    client.patch("/me", json={"last_folder_id": "dataset"})
    bob = _walk(client, 36)
    assert [p["id"] for p in bob] == [p["id"] for p in ada]
    assert all(p["elements"] == [] for p in bob)


def test_concurrent_first_visits_build_one_grid(girder):
    from simple_annotator.slides import ensure_slide

    def build(_):
        with session_factory()() as db:
            return ensure_slide(db, girder[0]).grid

    with ThreadPoolExecutor(4) as pool:
        assert len(set(pool.map(build, range(4)))) == 1
    with session_factory()() as db:
        assert len(db.scalars(select(Patch).where(Patch.girder_item_id == "histo")).all()) == 1
        assert db.get(Slide, "histo").histo


def test_old_patch_of_an_unreadable_image_reports_why(auth, girder, monkeypatch):
    from simple_annotator import slides
    from simple_annotator.models import PatchVisit, User

    monkeypatch.setattr(slides, "get_item", lambda _: {"_id": "gone", "folderId": "f"})
    monkeypatch.setattr(slides, "image_info", lambda _: (None, "Item not found."))
    with session_factory()() as db:
        user = db.scalar(select(User).where(User.username == "ada"))
        legacy = Patch(girder_item_id="gone", left=0, top=0, width=900, height=700)
        db.add(legacy)
        db.flush()
        visit = PatchVisit(user_id=user.id, patch_id=legacy.id, folder_id="dataset")
        db.add(visit)
        db.flush()
        user.current_visit_id = visit.id
        db.commit()
    response = auth.get("/patches/current")
    assert response.status_code == 502
    assert response.json()["detail"] == (
        "The image server (Girder) cannot read this image. Girder says: Item not found."
    )


def test_rebuilt_slides_keep_their_elmi_folder_and_name(girder, monkeypatch):
    from simple_annotator import slides

    item = {"_id": "histo", "name": "colour TEM.tif", "folderId": "elmi"}
    monkeypatch.setattr(slides, "get_item", lambda _: item)
    monkeypatch.setattr(slides, "is_elmi_folder", lambda folder: folder == "elmi")
    with session_factory()() as db:
        legacy = Patch(girder_item_id="histo", left=0, top=0, width=900, height=700)
        db.add(legacy)
        db.commit()
        slide, _ = slides.patch_scale(db, legacy)
        assert (slide.histo, slide.name) == (False, "colour TEM.tif")


def test_rebuilding_a_lost_slide_row_reuses_its_tiles(auth, girder):
    girder[0] = {"_id": "small", "name": "s.png"}
    first = auth.get("/patches/current").json()
    with session_factory()() as db:
        db.delete(db.get(Slide, "small"))
        db.commit()
    assert [p["id"] for p in _walk(auth, 3)] == [first["id"]] * 3
    assert auth.get("/patches/current").json()["slide"] is None
    with session_factory()() as db:
        assert len(db.scalars(select(Patch).where(Patch.girder_item_id == "small")).all()) == 1


@pytest.mark.parametrize("center", [1999, 2000, 2001, 4600])
def test_histology_boxes_up_to_400_um_fit_wherever_they_sit(center):
    from simple_annotator.config import HISTO_AI_MODEL
    from simple_annotator.embeddings import prompt_regions

    # 250 nm/px: 2000 px (500 µm) cores; a 400 µm box is 1600 px wide.
    request = {"model": HISTO_AI_MODEL.name, "width": 10000, "height": 10000, "nm_per_px": 250}
    box = [center - 800, center - 800, center + 800, center + 800]
    x, y, w, h = prompt_regions({**request, "box": box, "histo": True})[0]
    assert x <= box[0] and box[2] <= x + w and w <= 3600
    with pytest.raises(ValueError):
        prompt_regions({**request, "box": box})


def test_histology_prompts_and_preparation_use_default_sam(auth, girder):
    from simple_annotator.config import HISTO_AI_MODEL
    from simple_annotator.models import AiEmbedding

    patch = auth.get("/patches/current").json()
    with session_factory()() as db:
        models = {json.loads(row.input)["model"] for row in db.scalars(select(AiEmbedding))}
    assert models == {HISTO_AI_MODEL.name}
    auth.patch("/me", json={"last_job_id": 2})
    auth.get("/patches/current")
    with session_factory()() as db:
        models = {json.loads(row.input)["model"] for row in db.scalars(select(AiEmbedding))}
    assert models == {HISTO_AI_MODEL.name}
    assert patch["nm_per_px"] == 250
