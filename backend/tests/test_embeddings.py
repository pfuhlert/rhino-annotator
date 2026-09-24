import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import httpx
import pytest
from sqlalchemy import select

from simple_annotator.ai_worker import claim, fail, resume
from simple_annotator.config import AI_MODEL
from simple_annotator.db import session_factory
from simple_annotator.embeddings import embedding_id, regions, tile_request
from simple_annotator.models import AiEmbedding, PatchVisit


def test_open_queues_embeddings_once_across_visits_users_and_jobs(auth, monkeypatch):
    from simple_annotator import patches

    monkeypatch.setattr(patches, "fetch_image", lambda *_: (_ for _ in ()).throw(AssertionError()))
    first = auth.get("/patches/current").json()
    with session_factory()() as db:
        ids = set(db.scalars(select(AiEmbedding.id)))
        assert len(ids) == len(regions(1024, 1024))
        assert set(db.scalars(select(AiEmbedding.status))) == {"queued"}
        assert all(data is None for data in db.scalars(select(AiEmbedding.data)))
    auth.patch("/me", json={"last_job_id": 2})
    assert auth.get("/patches/next").json()["id"] != first["id"]
    auth.get("/patches/prev")
    auth.post("/auth/register", json={"username": "second", "password": "secret"})
    auth.get("/patches/current")
    with session_factory()() as db:
        assert set(db.scalars(select(AiEmbedding.id))) == ids


@pytest.mark.parametrize("status", ["queued", "running", "ready"])
def test_reopening_prepared_or_pending_image_needs_no_write_lock(auth, busy_db, status):
    first = auth.get("/patches/current").json()
    with session_factory()() as db:
        for row in db.scalars(select(AiEmbedding)):
            row.status = status
        db.commit()
    writer, blocked = busy_db
    writer.execute("BEGIN IMMEDIATE")
    try:
        response = auth.get("/patches/current")
        assert response.status_code == 200
        assert response.json() == first
        assert not blocked.is_set()
    finally:
        writer.rollback()


@pytest.mark.parametrize("release_lock", [True, False])
def test_first_open_responds_before_embedding_queue_retries(
    auth, busy_db, monkeypatch, caplog, release_lock
):
    from simple_annotator import patches

    writer, blocked = busy_db
    sent = Event()

    def metadata(_):
        # The visit has committed; a worker starts saving while metadata is fetched.
        writer.execute("BEGIN IMMEDIATE")
        return None

    monkeypatch.setattr(patches, "image_nm_per_px", metadata)

    async def app(scope, receive, send):
        async def observe(message):
            await send(message)
            if message["type"] == "http.response.body" and not message.get("more_body"):
                sent.set()

        await auth.app(scope, receive, observe)

    async def open_image():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url=auth.base_url, cookies=auth.cookies
        ) as client:
            return await client.get("/patches/current")

    with ThreadPoolExecutor(1) as pool:
        future = pool.submit(lambda: asyncio.run(open_image()))
        try:
            assert blocked.wait(3), "Queue insertion did not encounter the held lock"
            assert sent.is_set(), "Image response waited for embedding queue insertion"
            if release_lock:
                writer.rollback()
            response = future.result(timeout=3)
        finally:
            writer.rollback()
    assert response.status_code == 200
    with session_factory()() as db:
        assert len(db.scalars(select(PatchVisit)).all()) == 1
        assert len(db.scalars(select(AiEmbedding)).all()) == (
            len(regions(1024, 1024)) if release_lock else 0
        )
    if not release_lock:
        assert "preparation deferred" in caplog.text
    monkeypatch.setattr(patches, "image_nm_per_px", lambda _: None)
    assert auth.get("/patches/current").json()["id"] == response.json()["id"]
    with session_factory()() as db:
        assert len(db.scalars(select(PatchVisit)).all()) == 1
        assert len(db.scalars(select(AiEmbedding)).all()) == len(regions(1024, 1024))


def test_embedding_claims_are_exclusive_and_restart_preserves_ready_data(auth):
    auth.get("/patches/current")
    with ThreadPoolExecutor(2) as pool:
        claims = list(pool.map(lambda _: claim(AiEmbedding), range(2)))
    claims = [item for item in claims if item is not None]
    assert len({item[0] for item in claims}) == len(claims)
    if len(claims) == 1:
        claims.append(claim(AiEmbedding))
    with session_factory()() as db:
        row = db.get(AiEmbedding, claims[0][0])
        row.status, row.data = "ready", b"saved tensor"
        db.commit()
    resume()
    with session_factory()() as db:
        assert db.get(AiEmbedding, claims[1][0]).status == "queued"
        row = db.get(AiEmbedding, claims[0][0])
        assert row.status == "ready"
        assert row.data == b"saved tensor"


def test_failed_embeddings_do_not_retry_until_image_is_reopened(auth):
    auth.get("/patches/current")
    while item := claim(AiEmbedding):
        fail(item[0], "Image source unavailable", AiEmbedding)
    assert claim(AiEmbedding) is None
    auth.get("/patches/current")
    with session_factory()() as db:
        assert set(db.scalars(select(AiEmbedding.status))) == {"queued"}
        assert all(error is None for error in db.scalars(select(AiEmbedding.error)))


def test_cache_identity_uses_pixels_source_model_and_preprocessing():
    request = {"model": AI_MODEL, "item_id": "a", "left": 0, "top": 0}
    tile = tile_request(request, (0, 0, 384, 300))
    key = embedding_id(tile)
    assert key == embedding_id(tile_request({**request, "job_id": 7, "x": 10}, (0, 0, 384, 300)))
    for field, value in [
        ("model", "new-model"),
        ("recipe", "new-preprocessing"),
        ("source", "other-source"),
        ("item_id", "b"),
        ("left", 1),
        ("top", 1),
        ("width", 300),
        ("height", 200),
    ]:
        assert embedding_id({**tile, field: value}) != key
    assert embedding_id(json.loads(json.dumps(tile))) == key


def test_tiles_cover_rectangular_images_with_context_and_bound_whole_image_fallback():
    assert regions(320, 300) == [(0, 0, 320, 300)]
    tiles = regions(1024, 768)
    assert tiles[0] == (0, 0, 448, 448)
    assert (320, 0, 512, 448) in tiles
    assert (704, 320, 320, 448) in tiles
    assert tiles[-1] == (0, 0, 1024, 768)
    for y in range(768):
        assert sum(w for x, top, w, h in tiles[:-1] if top <= y < top + h) >= 1024
    assert all(w <= 512 and h <= 512 for _, _, w, h in regions(5000, 3000))


@pytest.mark.parametrize("calibration", [None, 0, -1, float("nan"), float("inf")])
def test_missing_or_invalid_scale_keeps_pixel_fallback(calibration):
    assert regions(1024, 768, calibration) == regions(1024, 768)


def test_physical_tiles_scale_with_magnification_and_preserve_small_rectangular_images():
    assert regions(1024, 768, 5)[0] == (0, 0, 700, 700)
    assert (500, 0, 524, 700) in regions(1024, 768, 5)
    assert regions(1024, 768, 12)[0] == (0, 0, 292, 292)
    assert (208, 208, 334, 334) in regions(1024, 768, 12)
    assert regions(2048, 1536, 0.48828125) == [(0, 0, 2048, 1536)]
    # Extreme but finite calibration must not create oversized inputs or per-pixel tiles.
    assert len(regions(1024, 768, 1e300)) <= 193
    assert all(w <= 4096 and h <= 4096 for _, _, w, h in regions(5000, 3000, 1e-300))
