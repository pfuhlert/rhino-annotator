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
    from simple_annotator import patches, slides

    items = [{"_id": "histo", "name": "slide.svs"}]
    monkeypatch.setattr(slides, "girder_enabled", lambda: True)
    monkeypatch.setattr(slides, "folder_images", lambda _: list(items))
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


def test_walks_each_slide_in_random_order_before_the_next_then_repeats(auth, girder):
    girder.extend([{"_id": "gray", "name": "gray.tif"}, {"_id": "small", "name": "s.png"}])
    first_pass = _walk(auth, 1 + 36 + 1)
    with session_factory()() as db:
        items = [db.get(Patch, p["id"]).girder_item_id for p in first_pass]
    runs = [item for i, item in enumerate(items) if i == 0 or items[i - 1] != item]
    assert sorted(runs) == ["gray", "histo", "small"]
    assert len({p["id"] for p in first_pass}) == len(first_pass)
    gray = next(p for p, item in zip(first_pass, items) if item == "gray")
    assert gray["nm_per_px"] is None and len(gray["slide"]["tiles"]) == 36
    small = next(p for p, item in zip(first_pass, items) if item == "small")
    assert small["slide"] is None
    second_pass = _walk(auth, 38)
    assert {p["id"] for p in second_pass} == {p["id"] for p in first_pass}


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


def test_repeated_passes_do_not_rescan_finished_ones(auth, girder):
    from sqlalchemy import event

    from simple_annotator.db import get_engine

    girder[0] = {"_id": "small", "name": "s.png"}
    tile = auth.get("/patches/current").json()["id"]
    _walk(auth, 30)
    statements = []

    def count(*_):
        statements.append(1)

    event.listen(get_engine(), "before_cursor_execute", count)
    try:
        assert auth.get("/patches/next").json()["id"] == tile
    finally:
        event.remove(get_engine(), "before_cursor_execute", count)
    assert len(statements) < 30


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
        db.commit()
        visit_id = visit.id
    response = auth.get(f"/patches/visits/{visit_id}")
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
