import csv
import io

from fastapi.testclient import TestClient

MASK = {"id": 1, "name": "Glomerulus", "color": "#e11d48"}


def _open_project(c: TestClient) -> dict:
    project = c.post("/api/projects", json={"name": "Masks", "jobs": [MASK]}).json()
    c.post(f"/api/projects/{project['id']}/open")
    return project


def test_marking_an_image_complete_and_undoing_it(auth):
    _open_project(auth)
    patch = auth.get("/patches/current").json()
    assert patch["complete"] is False
    url = f"/patches/{patch['id']}/complete"
    assert auth.put(f"{url}?complete=true").json() == {"complete": True}
    # Marking twice keeps one mark.
    assert auth.put(f"{url}?complete=true").json() == {"complete": True}
    assert auth.get("/patches/current").json()["complete"] is True
    row = next(i for i in auth.get("/images").json()["items"] if i["id"] == patch["item_id"])
    assert row["complete"] is True

    assert auth.put(f"{url}?complete=false").json() == {"complete": False}
    assert auth.get("/patches/current").json()["complete"] is False


def test_complete_images_without_masks_are_exported(auth, monkeypatch, three_images):
    from rhino_annotator import export

    monkeypatch.setattr(export, "item_folder_path", lambda _: "/collection/ELMI/batch")
    _open_project(auth)
    empty = auth.get("/patches/current").json()
    auth.put(f"/patches/{empty['id']}/complete?complete=true")
    masked = auth.get("/patches/next").json()
    square = [[0.0, 0.0], [4.0, 0.0], [4.0, 4.0], [0.0, 4.0]]
    mask = {"id": "m", "jobId": 1, "type": "polygon", "points": square}
    auth.patch(f"/patches/{masked['id']}/annotations", json={"upsert": [mask]})
    # The third image is opened but never marked: it is not in the export.
    auth.get("/patches/next")

    rows = list(csv.DictReader(io.StringIO(auth.get("/annotations/export.csv").text)))
    assert [(r["image_id"], r["type"]) for r in rows] == [
        (masked["item_id"], "polygon"),
        (empty["item_id"], "complete"),
    ]
    assert rows[1]["created_by"] == "ada"


def test_shared_projects_share_completion(auth):
    project = _open_project(auth)
    patch = auth.get("/patches/current").json()
    auth.put(f"/patches/{patch['id']}/complete?complete=true")
    auth.put(f"/api/projects/{project['id']}/sharing", json={"visibility": "everyone"})

    bob = TestClient(auth.app)
    bob.post("/auth/register", json={"username": "bob", "password": "secret"})
    bob.post(f"/api/projects/{project['id']}/open")
    assert bob.get("/patches/current").json()["complete"] is True
    stale = auth.put(f"/patches/{patch['id']}/complete?complete=false&shared=false")
    assert stale.status_code == 412
