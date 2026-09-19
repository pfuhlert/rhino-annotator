from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SIMPLE_ANNOTATOR_SQLITE", str(tmp_path / "t.sqlite"))
    monkeypatch.setenv("GIRDER_TOKEN", "")
    monkeypatch.setenv("GIRDER_FOLDER_ID", "")
    from simple_annotator import db

    db.reset_engine()
    from simple_annotator.main import create_app

    app = create_app()
    with TestClient(app) as c:
        yield c
    db.reset_engine()


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


def test_sticky_job_and_annotations(client: TestClient):
    client.post("/auth/register", json={"username": "ada", "password": "secret"})
    jobs = client.get("/jobs").json()
    assert {j["name"] for j in jobs} >= {"glomerulus", "tubule"}
    tubule = next(j for j in jobs if j["name"] == "tubule")
    patched = client.patch("/me", json={"last_job_id": tubule["id"]})
    assert patched.json()["last_job_id"] == tubule["id"]
    nxt = client.get("/patches/next")
    assert nxt.status_code == 200
    assert nxt.json()["job_id"] == tubule["id"]
    patch_id = nxt.json()["id"]
    img = client.get(f"/patches/{patch_id}/image")
    assert img.status_code == 200
    assert img.headers["content-type"] == "image/png"
    saved = client.post(
        f"/patches/{patch_id}/annotations",
        json={
            "job_id": tubule["id"],
            "elements": [{"type": "point", "points": [[10.0, 12.0]]}],
        },
    )
    assert saved.status_code == 200
    again = client.post(
        f"/patches/{patch_id}/annotations",
        json={
            "job_id": tubule["id"],
            "elements": [{"type": "point", "points": [[11.0, 13.0]]}],
        },
    )
    assert again.status_code == 200
    assert again.json()["id"] == saved.json()["id"]
    assert client.get("/me").json()["last_job_id"] == tubule["id"]
    assert client.get("/me").json()["done_count"] == 1
    nxt2 = client.get("/patches/next")
    assert nxt2.status_code == 200
    assert nxt2.json()["id"] != patch_id
    assert client.get("/me").json()["done_count"] == 1


def test_current_and_prev_patch(client: TestClient):
    client.post("/auth/register", json={"username": "ada", "password": "secret"})
    a = client.get("/patches/next").json()
    b = client.get("/patches/next").json()
    assert a["id"] != b["id"]
    assert b["has_prev"] is True
    assert client.get("/patches/current").json()["id"] == b["id"]
    back = client.get("/patches/prev").json()
    assert back["id"] == a["id"]
    assert back["has_prev"] is False
    assert client.get("/patches/current").json()["id"] == a["id"]
    again = client.get("/patches/next").json()
    assert again["id"] == b["id"]


def test_annotation_rejects_bad_type(client: TestClient):
    client.post("/auth/register", json={"username": "ada", "password": "secret"})
    patch_id = client.get("/patches/next").json()["id"]
    bad = client.post(
        f"/patches/{patch_id}/annotations",
        json={"job_id": 1, "elements": [{"type": "box", "points": [[0, 0]]}]},
    )
    assert bad.status_code == 400
