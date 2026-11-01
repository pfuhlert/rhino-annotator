import sqlite3
import threading
import time

from fastapi.testclient import TestClient

from simple_annotator import projects

POINT = {"id": "p1", "jobId": 1, "type": "point", "points": [[5.0, 6.0]]}


def _user(client: TestClient, name: str) -> TestClient:
    other = TestClient(client.app)
    other.post("/auth/register", json={"username": name, "password": "secret"})
    return other


def _create(c: TestClient, **body) -> dict:
    body = {"name": "GBM", "jobs": [{"id": 1, "name": "Glomerulus", "color": "#e11d48"}], **body}
    project = c.post("/api/projects", json=body).json()
    c.post(f"/api/projects/{project['id']}/open")
    return project


def _annotate(c: TestClient, *elements: dict) -> int:
    patch_id = c.get("/patches/current").json()["id"]
    assert c.patch(f"/patches/{patch_id}/annotations", json={"upsert": list(elements)}).is_success
    return patch_id


def _elements(c: TestClient) -> dict[str, list]:
    return {e["id"]: e["points"] for e in c.get("/patches/current").json()["elements"]}


def _projects(c: TestClient) -> set[tuple]:
    return {(p["name"], p["visibility"], p["owner"]) for p in c.get("/api/projects").json()}


def test_a_database_from_before_projects_gives_everyone_their_own_project(auth):
    from simple_annotator import db
    from simple_annotator.config import sqlite_path

    _annotate(auth, POINT)
    bob = _user(auth, "bob")
    _annotate(bob, {**POINT, "id": "b1"})
    db.reset_engine()
    # Rebuild the tables as they were before projects.
    old = {
        "users": "id INTEGER PRIMARY KEY, username VARCHAR(64) NOT NULL UNIQUE, "
        "password_hash VARCHAR(256) NOT NULL, last_job_id INTEGER, last_folder_id VARCHAR(64), "
        "stain_filter TEXT, current_visit_id INTEGER",
        "jobs": "id INTEGER PRIMARY KEY, name VARCHAR(64) NOT NULL UNIQUE, color VARCHAR(16)",
        "annotations": "id INTEGER PRIMARY KEY, element_id VARCHAR(100), item_id VARCHAR(64), "
        "user_id INTEGER REFERENCES users(id), job_id INTEGER REFERENCES jobs(id), "
        "type VARCHAR(16), geometry TEXT, x0 FLOAT, y0 FLOAT, x1 FLOAT, y1 FLOAT, "
        "created FLOAT, updated FLOAT, UNIQUE (user_id, item_id, element_id)",
        "patch_visits": "id INTEGER PRIMARY KEY, user_id INTEGER, patch_id INTEGER, "
        "folder_id VARCHAR(64)",
    }
    with sqlite3.connect(sqlite_path()) as conn:
        for table in ("project_opens", "project_members", "project_jobs", "project_folders"):
            conn.execute(f"DROP TABLE {table}")
        conn.execute("DROP TABLE projects")
        for table, columns in old.items():
            conn.execute(f"CREATE TABLE {table}_old ({columns})")
            names = ", ".join(r[1] for r in conn.execute(f"PRAGMA table_info({table}_old)"))
            conn.execute(f"INSERT INTO {table}_old ({names}) SELECT {names} FROM {table}")
            conn.execute(f"DROP TABLE {table}")
            conn.execute(f"ALTER TABLE {table}_old RENAME TO {table}")

    db.init_db()
    db.init_db()
    with sqlite3.connect(sqlite_path()) as conn:
        kinds = dict(conn.execute("SELECT name, kind FROM jobs"))
    assert (kinds["Glomerulus"], kinds["GBM"]) == ("histo", "elmi")
    assert _projects(auth) == {("All annotations", "private", "ada")}
    assert _projects(bob) == {("All annotations", "private", "bob")}
    assert _elements(auth) == {"p1": [[5.0, 6.0]]}
    assert _elements(bob) == {"b1": [[5.0, 6.0]]}
    # Label classes may now share a name: each project can add its own.
    _create(auth, jobs=[{"name": "Glomerulus", "color": "#000000"}])
    with sqlite3.connect(sqlite_path()) as conn:
        assert conn.execute("SELECT count(*) FROM jobs WHERE name = 'Glomerulus'").fetchone() == (
            2,
        )


def test_label_classes_get_a_kind_on_a_database_from_before_kinds(auth):
    from simple_annotator import db
    from simple_annotator.config import sqlite_path

    db.reset_engine()
    with sqlite3.connect(sqlite_path()) as conn:
        conn.execute("ALTER TABLE jobs DROP COLUMN kind")
        conn.execute("INSERT INTO jobs (name, color) VALUES ('Custom', '#000000')")
    db.init_db()
    db.init_db()
    with sqlite3.connect(sqlite_path()) as conn:
        kinds = dict(conn.execute("SELECT name, kind FROM jobs"))
    assert (kinds["Tubule"], kinds["Podocyte"], kinds["Custom"]) == ("histo", "elmi", "histo")


def test_folders_normalize_to_the_outermost_and_scope_the_browser(auth, monkeypatch):
    tree = {"a": (), "a/b": ("a",), "a/c": ("a",), "a/b/d": ("a/b", "a")}
    monkeypatch.setattr(projects, "ancestors", lambda f: tree.get(f, ()))
    assert projects.normalize(["a/b", "a/c", "a/b/d"]) == ["a/b", "a/c"]
    assert projects.normalize(["a/b", "a/c", "a"]) == ["a"]

    project = _create(auth, folders=["placeholder"])
    key = f"project-{project['id']}"
    level = auth.get("/folders", params={"scoped": True}).json()
    assert (level["id"], [c["id"] for c in level["children"]]) == (key, ["placeholder"])
    assert auth.get("/patches/current").json()["folder_id"] == key
    # Outside the project's folders falls back to all of them.
    auth.patch("/me", json={"last_folder_id": "elsewhere"})
    assert auth.get("/patches/current").json()["folder_id"] == key
    auth.patch("/me", json={"last_folder_id": "placeholder"})
    assert auth.get("/patches/current").json()["folder_id"] == "placeholder"


def test_only_people_with_access_see_a_project_and_only_the_owner_changes_it(auth):
    project = _create(auth)
    url = f"/api/projects/{project['id']}"
    bob, carol = _user(auth, "bob"), _user(auth, "carol")
    names = lambda c: {p["name"] for p in c.get("/api/projects").json()}  # noqa: E731

    assert names(bob) == {"All annotations"}
    assert bob.post(f"{url}/open").status_code == 404
    assert auth.put(f"{url}/sharing", json={"visibility": "people", "members": ["bob"]}).is_success
    assert names(bob) == names(auth) == {"All annotations", "GBM"}
    assert names(carol) == {"All annotations"}
    assert bob.post(f"{url}/open").is_success
    assert bob.patch(url, json={"name": "Mine"}).status_code == 403
    assert bob.delete(url).status_code == 403
    # The shared layer's user can never be added, and never signs in.
    from simple_annotator.db import session_factory
    from simple_annotator.models import Project, User

    with session_factory()() as db:
        layer = db.get(User, db.get(Project, project["id"]).layer_user_id).username
    hidden = auth.put(f"{url}/sharing", json={"visibility": "people", "members": [layer]})
    assert hidden.status_code == 404
    assert bob.post("/auth/login", json={"username": layer, "password": ""}).status_code == 401
    auth.put(f"{url}/sharing", json={"visibility": "everyone"})
    assert names(carol) == {"All annotations", "GBM"}


def test_sharing_copies_into_a_shared_layer_and_never_overwrites_it(auth):
    project = _create(auth)
    url = f"/api/projects/{project['id']}"
    _annotate(auth, POINT)
    shared = auth.put(f"{url}/sharing", json={"visibility": "everyone"}).json()
    assert (shared["shared_layer"], shared["annotation_count"]) == (True, 1)

    bob = _user(auth, "bob")
    bob.post(f"{url}/open")
    assert _elements(bob) == {"p1": [[5.0, 6.0]]}
    _annotate(bob, {**POINT, "points": [[7.0, 8.0]]})
    assert _elements(auth) == {"p1": [[7.0, 8.0]]}
    rows = auth.get("/annotations/export.csv").text.splitlines()
    assert rows[1].split(",")[-3:-1] == ["ada", "bob"]

    # Private again: the owner is back on their own, untouched annotations.
    auth.put(f"{url}/sharing", json={"visibility": "private"})
    assert _elements(auth) == {"p1": [[5.0, 6.0]]}
    _annotate(auth, {**POINT, "id": "p2"})
    auth.put(f"{url}/sharing", json={"visibility": "everyone"})
    assert _elements(auth) == {"p1": [[7.0, 8.0]]}
    assert auth.post(f"{url}/copy-annotations").json()["copied"] == 1
    assert auth.post(f"{url}/copy-annotations").json()["copied"] == 0
    assert _elements(auth) == {"p1": [[7.0, 8.0]], "p2": [[5.0, 6.0]]}

    # Another tab opening a different project leaves saves that name this one in its layer.
    default = next(p for p in auth.get("/api/projects").json() if p["name"] == "All annotations")
    auth.post(f"/api/projects/{default['id']}/open")
    scoped = f"?project={project['id']}"
    patch_id = auth.get(f"/patches/current{scoped}").json()["id"]
    edit = {"upsert": [{**POINT, "id": "p3"}]}
    assert auth.patch(f"/patches/{patch_id}/annotations{scoped}", json=edit).is_success
    assert "p3" not in _elements(auth)
    assert "p3" in {e["id"] for e in auth.get(f"/patches/current{scoped}").json()["elements"]}


def test_registering_starts_on_a_private_project_with_the_preset_label_classes(auth):
    [project] = auth.get("/api/projects").json()
    assert auth.get("/me").json()["last_project_id"] == project["id"]
    assert (project["name"], project["visibility"], project["is_owner"]) == (
        "All annotations",
        "private",
        True,
    )
    assert len(project["jobs"]) == 14
    # Other people's classes never reach the label list.
    _create(_user(auth, "bob"), jobs=[{"name": "Secret", "color": "#123456"}])
    assert "Secret" not in {j["name"] for j in auth.get("/jobs").json()}


def test_requests_never_wait_for_a_folder_listing_and_share_one(auth, monkeypatch):
    from simple_annotator import images

    walks, release = [], threading.Event()

    def slow_walk(folder_id):
        walks.append(folder_id)
        release.wait(5)
        return [{"_id": "a", "name": "a.tif", "folderId": folder_id}]

    monkeypatch.setattr(images, "girder_enabled", lambda: True)
    monkeypatch.setattr(images, "walk_images", slow_walk)
    auth.patch("/me", json={"last_folder_id": "big"})
    for _ in range(2):
        listing = auth.get("/images").json()
        assert (listing["folder_id"], listing["indexing"], listing["items"]) == ("big", True, [])
    assert auth.get("/patches/next").status_code == 503
    release.set()
    for _ in range(50):
        if not (listing := auth.get("/images").json())["indexing"]:
            break
        time.sleep(0.05)
    assert [it["id"] for it in listing["items"]] == ["a"]
    assert walks == ["big"]


def test_a_member_who_lost_access_cannot_cancel_ai_results_out_of_the_shared_layer(auth):
    from uuid import uuid4

    from simple_annotator.ai_worker import claim, complete
    from simple_annotator.db import session_factory
    from simple_annotator.models import AiWorker

    project = _create(auth)
    url = f"/api/projects/{project['id']}"
    auth.put(f"{url}/sharing", json={"visibility": "everyone"})
    bob = _user(auth, "bob")
    own = next(p for p in bob.get("/api/projects").json() if p["is_owner"])
    bob.post(f"{url}/open")
    with session_factory()() as db:
        db.add(AiWorker(id=1, updated=time.time(), status="ready"))
        db.commit()
    patch_id = bob.get("/patches/current").json()["id"]
    task = str(uuid4())
    prompt = {"id": task, "job_id": 1, "x": 30, "y": 20}
    assert bob.post(f"/patches/{patch_id}/ai", json=prompt).status_code == 202
    complete(claim()[0], {"points": [[10, 10], [50, 10], [30, 50]], "holes": []}, 10)

    auth.put(f"{url}/sharing", json={"visibility": "private"})
    assert bob.delete(f"/patches/ai/{task}?project={own['id']}").status_code == 404
    auth.put(f"{url}/sharing", json={"visibility": "everyone"})
    assert f"ai-{task}" in _elements(auth)
