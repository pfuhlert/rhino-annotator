import json
import time
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from sqlalchemy import select

from simple_annotator import ai
from simple_annotator.ai_worker import claim, complete
from simple_annotator.config import AI_PROFILES
from simple_annotator.db import session_factory
from simple_annotator.models import AiTask, AiWorker

POLYGON = {"points": [[10, 10], [50, 10], [30, 50]], "holes": []}


@pytest.fixture
def queued(auth, monkeypatch):
    monkeypatch.setitem(
        AI_PROFILES,
        "glomerulus",
        {"model": "microsam-em-1.2", "crop_nm": 3000, "crop_px": 512},
    )
    monkeypatch.setattr(ai, "image_nm_per_px", lambda _: 5)
    with session_factory()() as db:
        db.add(AiWorker(id=1, updated=time.time(), status="ready"))
        db.commit()
    patch = auth.get("/patches/current").json()["id"]
    prompt = {"id": str(uuid4()), "job_id": 1, "x": 30, "y": 20}
    response = auth.post(f"/patches/{patch}/ai", json=prompt)
    assert response.status_code == 202
    return patch, prompt


def marks(auth, patch):
    return auth.get(f"/patches/ai?patch_id={patch}").json()["elements"]


def test_queue_is_idempotent_and_captures_scale(auth, queued):
    patch, prompt = queued
    assert auth.post(f"/patches/{patch}/ai", json=prompt).status_code == 202
    assert next(j for j in auth.get("/jobs").json() if j["id"] == 1)["ai"]
    for changes in ({"x": 40}, {"y": 50}, {"job_id": 2}):
        assert auth.post(f"/patches/{patch}/ai", json={**prompt, **changes}).status_code == 409
    with session_factory()() as db:
        tasks = db.scalars(select(AiTask)).all()
        assert len(tasks) == 1
        payload = json.loads(tasks[0].input)
        assert payload["nm_per_px"] == 5
        assert payload["crop_nm"] == 3000
    task_id, _ = claim()
    auth.patch("/me", json={"last_job_id": 2})
    auth.get("/patches/next")
    complete(task_id, POLYGON, 20)
    result = marks(auth, patch)
    assert result[0]["jobId"] == 1
    assert result[0]["id"] == f"ai-{task_id}"


def test_background_and_manual_updates_merge_atomically(auth, queued):
    patch, prompt = queued
    task_id, _ = claim()
    manual = {"id": "manual", "jobId": 1, "type": "point", "points": [[70, 80]]}
    with ThreadPoolExecutor(2) as pool:
        future = pool.submit(complete, task_id, POLYGON, 10)
        response = auth.patch(f"/patches/{patch}/annotations", json={"upsert": [manual]})
        future.result()
    assert response.status_code == 200
    saved = auth.get("/patches/current").json()["elements"]
    assert {el["id"] for el in saved} == {"manual", f"ai-{task_id}"}
    manual["points"] = [[90, 80]]
    auth.patch(f"/patches/{patch}/annotations", json={"upsert": [manual]})
    assert marks(auth, patch)
    auth.patch(f"/patches/{patch}/annotations", json={"delete": [f"ai-{task_id}"]})
    assert marks(auth, patch) == []
    assert auth.get("/patches/current").json()["elements"] == [manual]


@pytest.mark.parametrize("state", ["queued", "running", "done"])
def test_cancellation_never_allows_late_results(auth, queued, state):
    patch, prompt = queued
    if state != "queued":
        claim()
    if state == "done":
        complete(prompt["id"], POLYGON, 10)
    assert auth.delete(f"/patches/ai/{prompt['id']}").status_code == 200
    if state == "running":
        complete(prompt["id"], POLYGON, 10)
    assert claim() is None
    assert marks(auth, patch) == []


def test_queue_rejects_invalid_points_and_unsupported_jobs(auth, queued):
    patch, _ = queued
    for overrides in ({"x": -1}, {"y": 100000}, {"job_id": 2}):
        prompt = {"id": str(uuid4()), "job_id": 1, "x": 30, "y": 20, **overrides}
        assert auth.post(f"/patches/{patch}/ai", json=prompt).status_code == 400


def test_other_users_cannot_access_tasks_or_edit_patches(auth, queued):
    patch, prompt = queued
    auth.post("/auth/register", json={"username": "other", "password": "secret"})
    assert auth.get(f"/patches/ai?patch_id={patch}").status_code == 404
    assert auth.delete(f"/patches/ai/{prompt['id']}").status_code == 404
    assert (
        auth.patch(f"/patches/{patch}/annotations", json={"delete": ["manual"]}).status_code == 404
    )


def test_scale_controls_crops_and_nearby_clicks_reuse_them():
    pytest.importorskip("torch")
    from simple_annotator.segmenter import crop_box

    request = {
        "x": 1100,
        "y": 1200,
        "width": 4096,
        "height": 3072,
        "nm_per_px": 5,
        "crop_nm": 3000,
        "crop_px": 512,
    }
    box = crop_box(request)
    assert box[2:] == (640, 640)
    assert crop_box({**request, "x": 1101}) == box
    assert crop_box({**request, "nm_per_px": 10})[2:] == (320, 320)
    assert crop_box({**request, "nm_per_px": None})[2:] == (512, 512)
    for x, y in [(0, 0), (4095, 3071)]:
        left, top, w, h = crop_box({**request, "x": x, "y": y})
        assert 0 <= left <= x < left + w <= 4096
        assert 0 <= top <= y < top + h <= 3072


def test_idle_poll_skips_annotation_geometry(auth, queued, monkeypatch):
    patch, _ = queued
    monkeypatch.setattr(ai, "elements", lambda *_: pytest.fail("idle poll read annotations"))
    status = auth.get(f"/patches/ai?patch_id={patch}").json()
    assert status["elements"] == []
    assert status["worker"] == "ready"
    with session_factory()() as db:
        worker = db.get(AiWorker, 1)
        worker.status = "loading"
        db.commit()
    assert auth.get(f"/patches/ai?patch_id={patch}").json()["worker"] == "loading"
    with session_factory()() as db:
        db.get(AiWorker, 1).updated = 0
        db.commit()
    assert auth.get(f"/patches/ai?patch_id={patch}").json()["worker"] == "offline"


def test_idle_worker_can_poll_during_an_annotation_write(auth):
    from simple_annotator.annotations import lock

    with session_factory()() as writer:
        lock(writer)
        assert claim() is None


def test_competing_claims_only_start_a_task_once(queued):
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda _: claim(), range(2)))
    assert sum(result is not None for result in results) == 1


def test_legacy_snapshot_save_cannot_erase_ai_result(auth, queued):
    patch, prompt = queued
    claim()
    complete(prompt["id"], POLYGON, 10)
    response = auth.post(f"/patches/{patch}/annotations", json={"job_id": 1, "elements": []})
    assert response.status_code == 405
    assert len(marks(auth, patch)) == 1
