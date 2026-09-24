import json
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import select

from simple_annotator import ai
from simple_annotator.ai_worker import claim, complete, process_next
from simple_annotator.config import AI_MODEL
from simple_annotator.db import session_factory
from simple_annotator.models import AiTask, AiWorker, Patch

POLYGON = {"points": [[10, 10], [50, 10], [30, 50]], "holes": []}


@pytest.fixture
def queued(auth):
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


def test_queue_is_idempotent_and_captures_image(auth, queued):
    patch, prompt = queued
    assert auth.post(f"/patches/{patch}/ai", json=prompt).status_code == 202
    for changes in ({"x": 40}, {"y": 50}, {"job_id": 2}):
        assert auth.post(f"/patches/{patch}/ai", json={**prompt, **changes}).status_code == 409
    with session_factory()() as db:
        tasks = db.scalars(select(AiTask)).all()
        assert len(tasks) == 1
        payload = json.loads(tasks[0].input)
        assert payload["model"] == AI_MODEL
        assert payload["width"] == payload["height"] == 1024
        assert "crop_nm" not in payload
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


def test_queue_rejects_invalid_points_and_unknown_jobs(auth, queued):
    patch, _ = queued
    for overrides in ({"x": -1}, {"y": 100000}, {"job_id": -1}):
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


def test_point_ai_is_available_for_every_job(auth, queued):
    patch, _ = queued
    for job in auth.get("/jobs").json():
        prompt = {"id": str(uuid4()), "job_id": job["id"], "x": 30, "y": 20}
        response = auth.post(f"/patches/{patch}/ai", json=prompt)
        assert response.status_code == 202
        assert response.json()["job_id"] == job["id"]


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


@pytest.mark.parametrize("stage", ["claim", "complete", "fail", "cancel"])
def test_worker_recovers_from_busy_database_without_repeating_prediction(queued, busy_db, stage):
    _, prompt = queued
    writer, blocked = busy_db
    calls = []

    def predict(request):
        calls.append(request)
        if stage != "claim":
            writer.execute("BEGIN IMMEDIATE")
        if stage == "fail":
            raise ValueError("No structure found")
        return POLYGON

    if stage == "claim":
        writer.execute("BEGIN IMMEDIATE")
    with ThreadPoolExecutor(1) as pool:
        future = pool.submit(process_next, {AI_MODEL: SimpleNamespace(predict=predict)})
        try:
            assert blocked.wait(3), "Worker did not encounter the held lock"
            assert not future.done()
            if stage == "cancel":
                writer.execute(
                    "UPDATE ai_tasks SET status = 'cancelled' WHERE id = ?", (prompt["id"],)
                )
                writer.commit()
        finally:
            writer.rollback()
        assert future.result(timeout=3)
    assert len(calls) == 1
    with session_factory()() as db:
        task = db.get(AiTask, prompt["id"])
        assert task.status == {"fail": "failed", "cancel": "cancelled"}.get(stage, "done")
        from simple_annotator.annotations import elements

        assert len(elements(db, task.user_id, task.patch_id)) == (stage not in ("fail", "cancel"))


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


@pytest.fixture
def queued_box(auth, queued):
    patch, point = queued
    auth.delete(f"/patches/ai/{point['id']}")
    prompt = {"id": str(uuid4()), "job_id": 2, "box": [17, 23, 231, 178]}
    response = auth.post(f"/patches/{patch}/ai", json=prompt)
    assert response.status_code == 202
    assert response.json()["box"] == prompt["box"]
    assert "x" not in response.json()
    return patch, prompt


def test_box_keeps_prompt_and_job(auth, queued_box):
    patch, prompt = queued_box
    assert auth.post(f"/patches/{patch}/ai", json=prompt).status_code == 202
    for changes in ({"box": [18, 23, 231, 178]}, {"job_id": 1}):
        assert auth.post(f"/patches/{patch}/ai", json={**prompt, **changes}).status_code == 409
    point = {"id": prompt["id"], "job_id": 2, "x": 17, "y": 23}
    assert auth.post(f"/patches/{patch}/ai", json=point).status_code == 409
    task_id, payload = claim()
    assert payload["model"] == AI_MODEL
    assert payload["box"] == prompt["box"]
    assert "crop_nm" not in payload
    assert "x" not in payload
    assert claim() is None
    auth.patch("/me", json={"last_job_id": 1})
    auth.get("/patches/next")
    complete(task_id, POLYGON, 20)
    result = marks(auth, patch)
    assert len(result) == 1
    assert result[0]["jobId"] == 2
    assert result[0]["type"] == "polygon"
    assert result[0]["id"] == f"ai-{task_id}"


@pytest.mark.parametrize("state", ["queued", "running", "done"])
def test_box_cancellation_prevents_late_results(auth, queued_box, state):
    patch, prompt = queued_box
    if state != "queued":
        claim()
    if state == "done":
        complete(prompt["id"], POLYGON, 10)
    assert auth.delete(f"/patches/ai/{prompt['id']}").status_code == 200
    if state == "running":
        complete(prompt["id"], POLYGON, 10)
    assert claim() is None
    assert marks(auth, patch) == []


@pytest.mark.parametrize(
    "box",
    [
        [-1, 0, 100, 100],
        [10, 10, 10, 20],
        [10, 10, 20, 10],
        [20, 10, 10, 20],
        [0, 0, 100000, 100],
        [0, 0, 100, 100000],
        [10, 10, 11, 20],
        [10.5, 10, 20, 20],
        ["NaN", 0, 20, 20],
        [0, 0, 20],
    ],
)
def test_invalid_boxes_are_rejected(auth, queued, box):
    patch, _ = queued
    prompt = {"id": str(uuid4()), "job_id": 2, "box": box}
    assert auth.post(f"/patches/{patch}/ai", json=prompt).status_code in (400, 422)


@pytest.mark.parametrize(
    "width,scale,box,expected",
    [
        (1024, None, [20, 20, 900, 700], 202),  # Whole-image fallback.
        (5000, None, [350, 200, 450, 300], 202),  # Overlapping tile.
        (5000, None, [20, 20, 900, 700], 400),
        (5000, 5, [20, 20, 900, 700], 400),
        (5000, 0.48828125, [20, 20, 900, 700], 202),
    ],
)
def test_box_coverage_is_validated_before_queueing(
    auth, queued, monkeypatch, width, scale, box, expected
):
    patch_id, _ = queued
    with session_factory()() as db:
        db.get(Patch, patch_id).width = width
        db.commit()
    monkeypatch.setattr(ai, "image_nm_per_px", lambda _: scale)
    prompt = {"id": str(uuid4()), "job_id": 2, "box": box}
    response = auth.post(f"/patches/{patch_id}/ai", json=prompt)
    assert response.status_code == expected
    with session_factory()() as db:
        assert (db.get(AiTask, prompt["id"]) is not None) == (expected == 202)
    if expected == 400:
        assert "larger than the available tiles" in response.json()["detail"]


def test_box_validates_job_and_worker_and_rejects_mixed_prompts(auth, queued_box):
    patch, prompt = queued_box
    prompt = {**prompt, "id": str(uuid4())}
    assert auth.post(f"/patches/{patch}/ai", json={**prompt, "job_id": -1}).status_code == 400
    assert auth.post(f"/patches/{patch}/ai", json={**prompt, "x": 10, "y": 10}).status_code == 422
    with session_factory()() as db:
        db.get(AiWorker, 1).updated = 0
        db.commit()
    assert auth.post(f"/patches/{patch}/ai", json=prompt).status_code == 503
