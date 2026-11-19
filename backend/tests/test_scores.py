import csv
import io

from fastapi.testclient import TestClient

GRADE = {"name": "Damage", "color": "#7c3aed", "mode": "score"}
MASK = {"id": 1, "name": "Glomerulus", "color": "#e11d48"}


def _project(c: TestClient) -> tuple[dict, int]:
    project = c.post("/api/projects", json={"name": "Grading", "jobs": [MASK, GRADE]}).json()
    c.post(f"/api/projects/{project['id']}/open")
    grade = next(j for j in project["jobs"] if j["mode"] == "score")
    return project, grade["id"]


def _user(client: TestClient, name: str) -> TestClient:
    other = TestClient(client.app)
    other.post("/auth/register", json={"username": name, "password": "secret"})
    return other


def test_a_project_mixes_mask_and_score_classes(auth):
    project, grade = _project(auth)
    assert [(j["name"], j["mode"]) for j in project["jobs"]] == [
        ("Glomerulus", "mask"),
        ("Damage", "score"),
    ]
    # Linking an existing class keeps its mode.
    again = auth.patch(
        f"/api/projects/{project['id']}",
        json={"jobs": [{**GRADE, "id": grade, "mode": "mask"}]},
    ).json()
    assert again["jobs"][0]["mode"] == "score"


def test_scoring_an_image_and_marking_it_not_scorable(auth):
    _project_, grade = _project(auth)
    patch = auth.get("/patches/current").json()
    assert patch["scores"] == {}
    url = f"/patches/{patch['id']}/scores"
    assert auth.put(url, json={"job_id": grade, "value": 70}).json()["scores"] == {str(grade): 70}
    assert auth.put(url, json={"job_id": grade, "value": "na"}).json()["scores"] == {
        str(grade): "na"
    }
    assert auth.get("/patches/current").json()["scores"] == {str(grade): "na"}
    assert auth.put(url, json={"job_id": grade, "value": 101}).status_code == 400
    # A mask class takes no score.
    assert auth.put(url, json={"job_id": 1, "value": 5}).status_code == 404

    images = auth.get("/images").json()["items"]
    assert next(i for i in images if i["id"] == patch["item_id"])["annotations"] == 1

    assert auth.delete(f"{url}/{grade}").json()["scores"] == {}
    assert auth.get("/patches/current").json()["scores"] == {}


def test_scores_are_exported_next_to_the_annotations(auth, monkeypatch, three_images):
    from simple_annotator import export

    monkeypatch.setattr(export, "item_folder_path", lambda _: "/collection/ELMI/batch")
    _project_, grade = _project(auth)
    first = auth.get("/patches/current").json()
    auth.put(f"/patches/{first['id']}/scores", json={"job_id": grade, "value": 40})
    second = auth.get("/patches/next").json()
    auth.put(f"/patches/{second['id']}/scores", json={"job_id": grade, "value": "na"})
    point = {"id": "p", "jobId": 1, "type": "point", "points": [[1.0, 2.0]]}
    auth.patch(f"/patches/{second['id']}/annotations", json={"upsert": [point]})

    rows = list(csv.DictReader(io.StringIO(auth.get("/annotations/export.csv").text)))
    assert [(r["type"], r["job"]) for r in rows] == [
        ("point", "Glomerulus"),
        ("score", "Damage"),
        ("score", "Damage"),
    ]
    scored = {r["image_id"]: r["score"] for r in rows if r["type"] == "score"}
    assert scored == {first["item_id"]: "40", second["item_id"]: ""}
    assert all(r["folder"] == "/collection/ELMI/batch" and r["created_by"] == "ada" for r in rows)


def test_shared_projects_share_scores(auth):
    project, grade = _project(auth)
    url = f"/api/projects/{project['id']}"
    patch = auth.get("/patches/current").json()
    auth.put(f"/patches/{patch['id']}/scores", json={"job_id": grade, "value": 30})
    shared = auth.put(f"{url}/sharing", json={"visibility": "everyone"}).json()
    assert shared["annotation_count"] == 1

    bob = _user(auth, "bob")
    bob.post(f"{url}/open")
    bob_patch = bob.get("/patches/current").json()
    assert bob_patch["scores"] == {str(grade): 30}
    bob.put(f"/patches/{bob_patch['id']}/scores", json={"job_id": grade, "value": 60})
    assert auth.get("/patches/current").json()["scores"] == {str(grade): 60}
    # A tab that loaded the private layer cannot write into the shared one.
    stale = auth.put(
        f"/patches/{patch['id']}/scores?shared=false", json={"job_id": grade, "value": 1}
    )
    assert stale.status_code == 412
