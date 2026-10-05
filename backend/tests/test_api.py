import json
import sqlite3

import httpx
import pytest
from fastapi.testclient import TestClient


def test_register_login_and_me(client: TestClient):
    r = client.post("/auth/register", json={"username": "ada", "password": "secret"})
    assert r.status_code == 200
    assert r.json()["username"] == "ada"
    assert r.json()["last_job_id"] == 1
    me = client.get("/me")
    assert me.status_code == 200
    assert me.json()["username"] == "ada"
    client.post("/auth/logout")
    assert client.get("/me").status_code == 401
    bad = client.post("/auth/login", json={"username": "ada", "password": "nope"})
    assert bad.status_code == 401
    ok = client.post("/auth/login", json={"username": "ada", "password": "secret"})
    assert ok.status_code == 200


def test_sticky_job_and_annotations(auth: TestClient):
    jobs = auth.get("/jobs").json()
    assert {j["name"] for j in jobs} >= {"glomerulus", "tubule"}
    tubule = next(j for j in jobs if j["name"] == "tubule")
    patched = auth.patch("/me", json={"last_job_id": tubule["id"]})
    assert patched.json()["last_job_id"] == tubule["id"]
    nxt = auth.get("/patches/next")
    assert nxt.status_code == 200
    assert nxt.json()["job_id"] == tubule["id"]
    patch_id = nxt.json()["id"]
    img = auth.get(nxt.json()["image"]["tile_url"].format(z=0, x=0, y=0))
    assert img.status_code == 200
    assert img.headers["content-type"] == "image/png"
    element = {"id": "point", "jobId": tubule["id"], "type": "point", "points": [[10, 12]]}
    saved = auth.patch(f"/patches/{patch_id}/annotations", json={"upsert": [element]})
    assert saved.status_code == 200
    element["points"] = [[11, 13]]
    again = auth.patch(f"/patches/{patch_id}/annotations", json={"upsert": [element]})
    assert again.status_code == 200
    assert auth.get("/patches/current").json()["elements"] == [element]
    me = auth.get("/me").json()
    assert me["last_job_id"] == tubule["id"]
    assert me["done_count"] == 1
    nxt2 = auth.get("/patches/next")
    assert nxt2.status_code == 200
    assert nxt2.json()["id"] != patch_id
    assert auth.get("/me").json()["done_count"] == 1


def test_current_and_prev_patch(auth: TestClient):
    a = auth.get("/patches/next").json()
    b = auth.get("/patches/next").json()
    assert a["id"] != b["id"]
    assert auth.get("/patches/current").json()["id"] == b["id"]
    back = auth.get("/patches/prev").json()
    assert back["id"] == a["id"]
    assert auth.get("/patches/current").json()["id"] == a["id"]
    assert auth.get("/patches/next").json()["id"] == b["id"]


def test_annotation_polygon_holes(auth: TestClient):
    patch_id = auth.get("/patches/next").json()["id"]
    points = [[0.0, 0.0], [100.0, 0.0], [100.0, 100.0], [0.0, 100.0]]
    holes = [[[20.0, 20.0], [40.0, 20.0], [40.0, 40.0], [20.0, 40.0]]]
    saved = auth.patch(
        f"/patches/{patch_id}/annotations",
        json={
            "upsert": [
                {"id": "shape", "jobId": 1, "type": "polygon", "points": points, "holes": holes}
            ]
        },
    )
    assert saved.status_code == 200
    el = next(e for e in auth.get("/patches/current").json()["elements"] if e["type"] == "polygon")
    assert el["points"] == points
    assert el["holes"] == holes
    again = auth.patch(
        f"/patches/{patch_id}/annotations",
        json={"upsert": [{"id": "shape", "jobId": 1, "type": "point", "points": [[1.0, 2.0]]}]},
    )
    assert again.status_code == 200
    loaded = auth.get("/patches/current").json()["elements"]
    assert [{k: v for k, v in e.items() if k != "id"} for e in loaded] == [
        {"type": "point", "points": [[1.0, 2.0]], "jobId": 1}
    ]


def test_annotation_rejects_bad_type(auth: TestClient):
    patch_id = auth.get("/patches/next").json()["id"]
    bad = auth.patch(
        f"/patches/{patch_id}/annotations",
        json={"upsert": [{"jobId": 1, "type": "box", "points": [[0, 0]]}]},
    )
    assert bad.status_code == 400


def test_folders_and_per_folder_series(auth: TestClient):
    folders = auth.get("/folders").json()
    assert folders["children"][0]["id"] == "placeholder"
    assert folders["children"][0]["n_items"] == 1
    me = auth.get("/me").json()
    assert me["last_folder_id"] is None
    a = auth.get("/patches/current").json()
    assert auth.get("/me").json()["last_folder_id"] == "placeholder"
    b = auth.get("/patches/next").json()
    assert b["id"] != a["id"]
    switched = auth.patch("/me", json={"last_folder_id": "other"})
    assert switched.json()["last_folder_id"] == "other"
    assert auth.get("/patches/current").json()["id"] == a["id"]
    auth.get("/patches/next")
    c = auth.get("/patches/next").json()
    assert c["id"] not in {a["id"], b["id"]}
    auth.patch("/me", json={"last_folder_id": "placeholder"})
    assert auth.get("/patches/current").json()["id"] == b["id"]
    assert auth.get("/patches/prev").json()["id"] == a["id"]
    auth.patch("/me", json={"last_folder_id": "other"})
    assert auth.get("/patches/current").json()["id"] == c["id"]


def test_stain_filter_is_kept_per_folder_choice(auth: TestClient):
    auth.patch("/me", json={"last_folder_id": "a"})
    assert auth.patch("/me", json={"stain_filter": ["PAS", None]}).json()["stain_filter"] == [
        "PAS",
        None,
    ]
    assert auth.patch("/me", json={"last_folder_id": "a"}).json()["stain_filter"] == ["PAS", None]
    kept = auth.patch("/me", json={"last_job_id": 2}).json()
    assert (kept["stain_filter"], kept["done_count"]) == (["PAS", None], 0)
    assert auth.patch("/me", json={"last_folder_id": "b"}).json()["stain_filter"] == []
    auth.patch("/me", json={"stain_filter": ["HE"]})
    assert auth.patch("/me", json={"stain_filter": []}).json()["stain_filter"] == []


def test_elmi_jobs(auth: TestClient, monkeypatch: pytest.MonkeyPatch):
    from simple_annotator import girder
    from simple_annotator.db import ELMI_JOBS, SEED_JOBS

    monkeypatch.setenv("GIRDER_TOKEN", "test")

    def respond(request):
        if request.url.path == "/folder/elmi":
            return httpx.Response(400, json={})
        if request.url.path == "/collection/elmi":
            return httpx.Response(200, json={"name": "ELMI"})
        pytest.fail(f"Unexpected request: {request.url}")

    with httpx.Client(base_url="https://girder.test", transport=httpx.MockTransport(respond)) as gc:
        monkeypatch.setattr(girder, "_gc", gc)
        assert [j["name"] for j in auth.get("/jobs").json()] == [n for n, _ in SEED_JOBS]
        auth.patch("/me", json={"last_folder_id": "elmi"})
        assert [j["name"] for j in auth.get("/jobs").json()] == [n for n, _ in ELMI_JOBS]


def test_new_girder_user_can_load_folder_picker(auth, monkeypatch):
    from simple_annotator import girder

    monkeypatch.setenv("GIRDER_TOKEN", "test")
    monkeypatch.setattr(girder, "_kids_cache", {})

    def respond(request):
        if request.url.path == "/collection":
            return httpx.Response(200, json=[{"_id": "dataset", "name": "Dataset"}])
        if request.url.path == "/folder":
            assert request.url.params["parentType"] == "collection"
            return httpx.Response(200, json=[{"_id": "images", "name": "Images"}])
        pytest.fail(f"Unexpected request: {request.url}")

    with httpx.Client(base_url="https://girder.test", transport=httpx.MockTransport(respond)) as gc:
        monkeypatch.setattr(girder, "_gc", gc)
        patch = auth.get("/patches/current").json()
        root = auth.get("/folders")
        selected = auth.get("/folders", params={"parent_id": patch["folder_id"]})
    assert root.status_code == selected.status_code == 200
    assert root.json()["children"][0]["id"] == "dataset"
    assert selected.json()["parent_id"] is None
    assert selected.json()["children"] == []


@pytest.mark.parametrize("existing_columns", [False, True])
@pytest.mark.parametrize("legacy_folder", ["", "old-girder-folder"])
def test_folder_migration_preserves_history(auth, monkeypatch, existing_columns, legacy_folder):
    from sqlalchemy import text

    from simple_annotator import db

    monkeypatch.setenv("GIRDER_FOLDER_ID", legacy_folder)
    first = auth.get("/patches/current").json()
    auth.get("/patches/next")
    auth.get("/patches/prev")
    with db.get_engine().begin() as conn:
        if legacy_folder:
            conn.execute(text("UPDATE patches SET girder_item_id = 'legacy-image'"))
        if existing_columns:
            conn.execute(text("UPDATE patch_visits SET folder_id = NULL"))
            conn.execute(text("UPDATE users SET last_folder_id = NULL"))
        else:
            conn.execute(text("ALTER TABLE patch_visits DROP COLUMN folder_id"))
            conn.execute(text("ALTER TABLE users DROP COLUMN last_folder_id"))

    db.init_db()
    db.init_db()
    current = auth.get("/patches/current").json()
    assert current["id"] == first["id"]
    assert current["folder_id"] == (legacy_folder or "placeholder")


def test_annotation_saves_preserve_selected_job(auth: TestClient):
    auth.patch("/me", json={"last_job_id": 2})
    patch_id = auth.get("/patches/current").json()["id"]
    path = f"/patches/{patch_id}/annotations"
    element = {"id": "point", "jobId": 1, "type": "point", "points": [[10.0, 12.0]]}
    for changes, expected in [({"upsert": [element]}, [element]), ({"delete": ["point"]}, [])]:
        assert auth.patch(path, json=changes).status_code == 200
        assert auth.get("/me").json()["last_job_id"] == 2
        current = auth.get("/patches/current").json()
        assert current["job_id"] == 2
        assert current["elements"] == expected
    assert auth.patch(path, json={"upsert": [{**element, "jobId": -1}]}).status_code == 404


def test_patch_calibration_follows_image_through_history(auth, monkeypatch):
    from simple_annotator import patches, slides
    from simple_annotator.db import session_factory
    from simple_annotator.models import Patch

    existing = auth.get("/patches/current").json()
    assert existing["nm_per_px"] is None
    with session_factory()() as db:
        tiles = [
            Patch(girder_item_id=item, left=0, top=0, width=2048, height=2048) for item in "ab"
        ]
        db.add_all(tiles)
        db.commit()
        queue = iter([tile.id for tile in tiles * 2])
    monkeypatch.setattr(patches, "step", lambda db, *_: db.get(Patch, next(queue)))
    monkeypatch.setattr(
        slides, "image_nm_per_px", lambda item: {"a": 0.48828125, "b": 4.8828125}.get(item)
    )
    a = auth.get("/patches/next").json()
    b = auth.get("/patches/next").json()
    assert a["nm_per_px"] == 0.48828125
    assert b["nm_per_px"] == 4.8828125
    assert auth.get("/patches/prev").json()["nm_per_px"] == a["nm_per_px"]
    assert auth.get("/patches/current").json()["nm_per_px"] == a["nm_per_px"]
    assert auth.get("/patches/next").json()["nm_per_px"] == b["nm_per_px"]


def test_annotations_follow_the_image_into_overlapping_patches(auth):
    first = auth.get("/patches/current").json()
    second = auth.get("/patches/next").json()
    dx = second["image"]["left"] - first["image"]["left"]
    assert first["item_id"] == second["item_id"] and 0 < dx < first["image"]["width"]
    shared = {"id": "shared", "jobId": 1, "type": "point", "points": [[dx + 5.0, 12.0]]}
    own = {"id": "own", "jobId": 1, "type": "point", "points": [[5.0, 12.0]]}
    response = auth.patch(f"/patches/{first['id']}/annotations", json={"upsert": [shared, own]})
    assert response.status_code == 200
    assert auth.get("/patches/current").json()["elements"] == [{**shared, "points": [[5.0, 12.0]]}]
    moved = {**shared, "points": [[7.0, 12.0]]}
    auth.patch(f"/patches/{second['id']}/annotations", json={"upsert": [moved]})
    loaded = auth.get("/patches/prev").json()["elements"]
    assert {el["id"]: el for el in loaded} == {
        "shared": {**moved, "points": [[dx + 7.0, 12.0]]},
        "own": own,
    }


def _legacy_annotations(rows, user_id):
    from sqlalchemy import text

    from simple_annotator import db

    with db.get_engine().begin() as conn:
        conn.execute(text("DROP TABLE annotations"))
        conn.execute(
            text(
                "CREATE TABLE annotations (id INTEGER PRIMARY KEY, patch_id INTEGER, "
                "user_id INTEGER, job_id INTEGER, elements TEXT)"
            )
        )
        for patch_id, marks in rows:
            conn.execute(
                text("INSERT INTO annotations VALUES (NULL, :p, :u, 1, :e)"),
                {"p": patch_id, "u": user_id, "e": json.dumps(marks)},
            )


def test_patch_annotations_migrate_to_image_coordinates(auth):
    from simple_annotator import db
    from simple_annotator.config import sqlite_path

    first = auth.get("/patches/current").json()
    second = auth.get("/patches/next").json()
    user_id = auth.get("/me").json()["id"]
    dx = second["image"]["left"] - first["image"]["left"]
    rows = [
        (first["id"], [{"type": "point", "points": [[dx + 5, 10]]}]),
        (first["id"], [{"type": "point", "points": [[1, 2]]}]),
        (second["id"], [{"id": "kept", "type": "polygon", "points": [[1, 1], [9, 1], [9, 9]]}]),
    ]
    _legacy_annotations(rows, user_id)

    db.init_db()
    db.init_db()
    assert auth.get("/patches/current").json()["elements"] == [
        {"id": "legacy-1-0", "jobId": 1, "type": "point", "points": [[5, 10]]},
        {"id": "kept", "jobId": 1, "type": "polygon", "points": [[1, 1], [9, 1], [9, 9]]},
    ]
    assert [el["id"] for el in auth.get("/patches/prev").json()["elements"]] == [
        "legacy-1-0",
        "legacy-2-0",
        "kept",
    ]
    with sqlite3.connect(sqlite_path()) as conn:
        assert conn.execute("SELECT count(*) FROM annotations_json").fetchone() == (3,)
    assert auth.get("/me").json()["done_count"] == 1


def test_failed_annotation_migration_leaves_the_old_table_intact(auth, monkeypatch):
    from simple_annotator import db
    from simple_annotator.config import sqlite_path

    patch = auth.get("/patches/current").json()
    _legacy_annotations([(patch["id"], [{"type": "point", "points": [[1, 2]]}])], 1)

    def broken(*_):
        raise RuntimeError("interrupted")

    monkeypatch.setattr(db, "element_row", broken)
    with pytest.raises(RuntimeError):
        db.init_db()
    with sqlite3.connect(sqlite_path()) as conn:
        assert "patch_id" in {row[1] for row in conn.execute("PRAGMA table_info(annotations)")}
        assert conn.execute("SELECT count(*) FROM annotations").fetchone() == (1,)
    monkeypatch.undo()
    db.init_db()
    assert [el["points"] for el in auth.get("/patches/current").json()["elements"]] == [[[1, 2]]]


@pytest.mark.parametrize("points", [[], [[1, 2, 3]], [[1]]])
def test_annotations_without_valid_points_are_rejected(auth, points):
    patch_id = auth.get("/patches/current").json()["id"]
    element = {"jobId": 1, "type": "polygon", "points": points}
    response = auth.patch(f"/patches/{patch_id}/annotations", json={"upsert": [element]})
    assert response.status_code == 422
    assert auth.get("/patches/current").json()["elements"] == []


def test_image_server_failure_returns_clear_error(auth: TestClient, monkeypatch):
    from simple_annotator import patches

    tile_url = auth.get("/patches/current").json()["image"]["tile_url"].format(z=0, x=0, y=0)
    request = httpx.Request("GET", "https://girder.test/item/x/tiles/zxy/0/0/0")

    def down(*_args):
        raise httpx.HTTPStatusError("404", request=request, response=httpx.Response(404))

    monkeypatch.setattr(patches, "tile", down)
    r = auth.get(tile_url)
    assert r.status_code == 502
    assert r.json()["detail"] == (
        "The image server (Girder) returned an error (404). Please try again later."
    )

    def unreachable(*_args):
        raise httpx.ConnectError("refused", request=request)

    monkeypatch.setattr(patches, "tile", unreachable)
    r = auth.get(tile_url)
    assert r.status_code == 502
    assert "could not be reached" in r.json()["detail"]


def test_folder_rows_count_own_images_next_to_subfolders(auth, monkeypatch):
    from simple_annotator import girder

    monkeypatch.setenv("GIRDER_TOKEN", "test")
    monkeypatch.setattr(girder, "_kids_cache", {})
    monkeypatch.setattr(girder, "_images_cache", {})
    kids = {"top": ["mixed", "nested", "empty"], "mixed": ["sub"], "nested": ["leaf"]}
    images = {"mixed": 3, "leaf": 2}

    def respond(request):
        path, params = request.url.path, request.url.params
        if path == "/folder/top":
            return httpx.Response(200, json={"_id": "top", "name": "Top", "parentId": None})
        if path == "/folder":
            ids = kids.get(params["parentId"], [])
            return httpx.Response(200, json=[{"_id": i, "name": i} for i in ids])
        if path.endswith("/details"):
            return httpx.Response(200, json={"nFolders": len(kids.get(path.split("/")[2], []))})
        if path == "/item":
            n = images.get(params["folderId"], 0) if params["offset"] == "0" else 0
            return httpx.Response(
                200, json=[{"_id": f"i{k}", "name": f"{k}.tif"} for k in range(n)]
            )
        pytest.fail(f"Unexpected request: {request.url}")

    with httpx.Client(base_url="https://girder.test", transport=httpx.MockTransport(respond)) as gc:
        monkeypatch.setattr(girder, "_gc", gc)
        rows = auth.get("/folders", params={"parent_id": "top"}).json()["children"]
    assert [(r["id"], r["n_items"], r["n_folders"]) for r in rows] == [
        ("mixed", 3, 1),
        ("nested", 0, 1),
    ]


def test_unreadable_dataset_explains_why(auth, monkeypatch):
    from simple_annotator import girder

    monkeypatch.setenv("GIRDER_TOKEN", "test")
    monkeypatch.setattr(girder, "_kids_cache", {})
    monkeypatch.setattr(girder, "_images_cache", {})
    missing = {"message": "This assetstore does not expose file paths."}

    def respond(request):
        path = request.url.path
        if path == "/folder/broken":
            return httpx.Response(200, json={"_id": "broken", "name": "Lupus", "parentId": "em"})
        if path == "/folder":
            return httpx.Response(200, json=[])
        if path == "/item":
            items = [{"_id": "a", "name": "a.tif"}, {"_id": "b", "name": "b.tif"}]
            return httpx.Response(200, json=items if request.url.params["offset"] == "0" else [])
        if path.endswith("/tiles"):
            return httpx.Response(500, json=missing)
        if path.startswith("/collection/") or path.startswith("/folder/"):
            return httpx.Response(404, json={})
        pytest.fail(f"Unexpected request: {request.url}")

    with httpx.Client(base_url="https://girder.test", transport=httpx.MockTransport(respond)) as gc:
        monkeypatch.setattr(girder, "_gc", gc)
        auth.patch("/me", json={"last_folder_id": "broken"})
        r = auth.get("/patches/current")
    assert r.status_code == 400
    assert r.json()["detail"] == (
        "None of the 2 images in this dataset can be read by the image server. "
        "Girder says: This assetstore does not expose file paths."
    )
