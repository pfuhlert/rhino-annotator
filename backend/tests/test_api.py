from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SIMPLE_ANNOTATOR_SQLITE", str(tmp_path / "t.sqlite"))
    monkeypatch.setenv("GIRDER_TOKEN", "")
    from simple_annotator import db

    db.reset_engine()
    from simple_annotator.main import create_app

    app = create_app()
    with TestClient(app) as c:
        yield c
    db.reset_engine()


@pytest.fixture
def auth(client: TestClient):
    client.post("/auth/register", json={"username": "ada", "password": "secret"})
    return client


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
    img = auth.get(f"/patches/{patch_id}/image")
    assert img.status_code == 200
    assert img.headers["content-type"] == "image/png"
    body = {"job_id": tubule["id"], "elements": [{"type": "point", "points": [[10.0, 12.0]]}]}
    saved = auth.post(f"/patches/{patch_id}/annotations", json=body)
    assert saved.status_code == 200
    again = auth.post(
        f"/patches/{patch_id}/annotations",
        json={"job_id": tubule["id"], "elements": [{"type": "point", "points": [[11.0, 13.0]]}]},
    )
    assert again.status_code == 200
    assert again.json()["id"] == saved.json()["id"]
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
    assert b["has_prev"] is True
    assert auth.get("/patches/current").json()["id"] == b["id"]
    back = auth.get("/patches/prev").json()
    assert back["id"] == a["id"]
    assert back["has_prev"] is False
    assert auth.get("/patches/current").json()["id"] == a["id"]
    assert auth.get("/patches/next").json()["id"] == b["id"]


def test_annotation_polygon_holes(auth: TestClient):
    patch_id = auth.get("/patches/next").json()["id"]
    points = [[0.0, 0.0], [100.0, 0.0], [100.0, 100.0], [0.0, 100.0]]
    holes = [[[20.0, 20.0], [40.0, 20.0], [40.0, 40.0], [20.0, 40.0]]]
    saved = auth.post(
        f"/patches/{patch_id}/annotations",
        json={"job_id": 1, "elements": [{"type": "polygon", "points": points, "holes": holes}]},
    )
    assert saved.status_code == 200
    el = next(e for e in auth.get("/patches/current").json()["elements"] if e["type"] == "polygon")
    assert el["points"] == points
    assert el["holes"] == holes
    again = auth.post(
        f"/patches/{patch_id}/annotations",
        json={"job_id": 1, "elements": [{"type": "point", "points": [[1.0, 2.0]]}]},
    )
    assert again.status_code == 200
    loaded = auth.get("/patches/current").json()["elements"]
    assert loaded == [{"type": "point", "points": [[1.0, 2.0]], "jobId": 1}]


def test_annotation_rejects_bad_type(auth: TestClient):
    patch_id = auth.get("/patches/next").json()["id"]
    bad = auth.post(
        f"/patches/{patch_id}/annotations",
        json={"job_id": 1, "elements": [{"type": "box", "points": [[0, 0]]}]},
    )
    assert bad.status_code == 400


def test_folders_and_per_folder_series(auth: TestClient):
    folders = auth.get("/folders").json()
    assert folders["children"][0]["id"] == "placeholder"
    assert folders["children"][0]["n_items"] == 1
    me = auth.get("/me").json()
    assert me["last_folder_id"] is None
    a = auth.get("/patches/current").json()
    assert a["has_prev"] is False
    assert auth.get("/me").json()["last_folder_id"] == "placeholder"
    b = auth.get("/patches/next").json()
    assert b["id"] != a["id"]
    assert b["has_prev"] is True
    switched = auth.patch("/me", json={"last_folder_id": "other"})
    assert switched.json()["last_folder_id"] == "other"
    c = auth.get("/patches/current").json()
    assert c["id"] not in {a["id"], b["id"]}
    assert c["has_prev"] is False
    assert auth.get("/patches/prev").status_code == 404
    d = auth.get("/patches/next").json()
    assert d["has_prev"] is True
    assert d["id"] != c["id"]
    auth.patch("/me", json={"last_folder_id": "placeholder"})
    back = auth.get("/patches/current").json()
    assert back["id"] == b["id"]
    assert back["has_prev"] is True
    assert auth.get("/patches/prev").json()["id"] == a["id"]
    auth.patch("/me", json={"last_folder_id": "other"})
    again = auth.get("/patches/current").json()
    assert again["id"] == d["id"]
    assert again["has_prev"] is True
    assert auth.get("/patches/prev").json()["id"] == c["id"]


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
    second = auth.get("/patches/next").json()
    auth.get("/patches/prev")
    element = {"type": "point", "points": [[10.0, 12.0]]}
    auth.post(f"/patches/{first['id']}/annotations", json={"job_id": 1, "elements": [element]})
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
    assert current["elements"] == [{**element, "jobId": 1}]
    assert auth.get("/patches/next").json()["id"] == second["id"]
    assert auth.get("/patches/prev").json()["id"] == first["id"]
