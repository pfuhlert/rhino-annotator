import io
import json
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from random import Random
from uuid import uuid4

import pytest
from PIL import Image
from sqlalchemy import select

pytest.importorskip("torch")
import numpy as np
import torch

from simple_annotator import segmenter, slides
from simple_annotator.ai_worker import process_next
from simple_annotator.config import DEFAULT_AI_MODEL, AiModel
from simple_annotator.db import reset_engine, session_factory
from simple_annotator.embeddings import embedding_id, prompt_regions, regions, tile_request
from simple_annotator.models import AiEmbedding, AiTask, AiWorker, Patch

REQUEST = {
    "model": DEFAULT_AI_MODEL.name,
    "item_id": "image",
    "left": 100,
    "top": 200,
    "width": 320,
    "height": 300,
}


@pytest.fixture
def fake_model(client, monkeypatch):
    fetched, encoded, prompts = [], [], []

    class Predictor:
        device = "cpu"

        def set_image(self, pixels):
            encoded.append(pixels.shape)
            self.original_size = self.input_size = pixels.shape[:2]
            self.features = torch.arange(8, dtype=torch.float32).reshape(1, 2, 2, 2)

        def predict(self, **kwargs):
            prompts.append(kwargs)
            h, w = self.original_size
            mask = np.zeros((1, h, w), dtype=bool)
            if "box" in kwargs:
                x0, y0, x1, y1 = kwargs["box"].astype(int)
                mask[0, max(0, y0 - 2) : min(h, y1 + 2), max(0, x0 - 2) : min(w, x1 + 2)] = True
                mask[0, y0 + 6 : y0 + 14, x0 + 10 : x0 + 25] = False
                mask[0, :2, :2] = True
            else:
                x, y = np.round(kwargs["point_coords"][0]).astype(int)
                mask[0, max(0, y - 10) : min(h, y + 11), max(0, x - 30) : min(w, x + 31)] = True
            return mask, np.array([0.9]), None

    def fetch(*args):
        fetched.append(args)
        output = io.BytesIO()
        Image.new("RGB", args[3:], (17, 29, 53)).save(output, format="PNG")
        return output.getvalue()

    def create():
        model = segmenter.MicroSam.__new__(segmenter.MicroSam)
        model.predictor = Predictor()
        model.cache = OrderedDict()
        return model

    monkeypatch.setattr(segmenter, "fetch_image", fetch)
    return create, fetched, encoded, prompts


def test_points_and_boxes_share_full_rectangular_image_after_worker_restart(fake_model):
    create, fetched, encoded, prompts = fake_model
    model = create()
    model.prepare(tile_request(REQUEST, (0, 0, 320, 300)))
    assert fetched == [("image", 100, 200, 320, 300)]
    assert encoded == [(300, 320, 3)]
    with session_factory()() as db:
        row = db.scalar(select(AiEmbedding))
        assert row.status == "ready"
        assert row.data
    # Discard both the predictor and its GPU cache, as happens on worker restart.
    reset_engine()
    model = create()
    point = model.predict({**REQUEST, "x": 100, "y": 100})
    assert min(x for x, _ in point["points"]) == 70
    box = [17, 23, 57, 43]
    polygon = model.predict({**REQUEST, "box": box})
    assert len(polygon["holes"]) == 1
    assert min(x for x, _ in polygon["points"]) == 17
    assert min(y for _, y in polygon["points"]) == 23
    for ring in [polygon["points"], *polygon["holes"]]:
        assert all(17 <= x < 57 and 23 <= y < 43 for x, y in ring)
    np.testing.assert_array_equal(prompts[1]["box"], box)
    np.testing.assert_array_equal(
        model.predictor.features.numpy(), np.arange(8).reshape(1, 2, 2, 2)
    )
    assert len(fetched) == len(encoded) == 1


def test_prepare_only_caches_embeddings_after_successful_persistence(
    fake_model, busy_db, monkeypatch
):
    create, _, encoded, _ = fake_model
    model = create()
    request = tile_request(REQUEST, (0, 0, 320, 300))

    def failed_save(*_):
        raise RuntimeError("Storage unavailable")

    with monkeypatch.context() as patch:
        patch.setattr(segmenter, "save_embedding", failed_save)
        with pytest.raises(RuntimeError, match="Storage unavailable"):
            model.prepare(request)
    assert not model.cache
    with session_factory()() as db:
        assert db.get(AiEmbedding, embedding_id(request)) is None
    model.prepare(request)
    assert len(encoded) == 2
    writer, blocked = busy_db
    writer.execute("BEGIN EXCLUSIVE")
    try:
        # A memory hit needs no database access: persistence already succeeded.
        model.prepare(request)
        assert not blocked.is_set()
    finally:
        writer.rollback()
    with session_factory()() as db:
        row = db.get(AiEmbedding, embedding_id(request))
        assert row.status == "ready" and row.data
    assert len(encoded) == 2


@pytest.mark.parametrize("calibration, count", [(None, 10), (5, 5), (12, 26), (0.48828125, 1)])
def test_calibrated_prompts_reuse_automatically_prepared_embeddings(
    auth, fake_model, monkeypatch, calibration, count
):
    from simple_annotator.annotations import lock

    def lookup(_):
        # Metadata fetching must not hold a write lock needed by the GPU worker.
        with session_factory()() as db:
            lock(db)
            db.commit()
        return calibration

    monkeypatch.setattr(slides, "image_nm_per_px", lookup)
    patch = auth.get("/patches/current").json()
    assert patch["nm_per_px"] == calibration
    create, fetched, encoded, _ = fake_model
    model = create()
    for _ in range(count):
        assert process_next({DEFAULT_AI_MODEL.name: model})
    assert process_next({DEFAULT_AI_MODEL.name: model}) is False
    assert len(encoded) == count
    with session_factory()() as db:
        db.add(AiWorker(id=1, updated=time.time(), status="ready"))
        db.commit()
    # A fresh worker must load the prepared pixels for both calibrated prompts.
    model = create()
    for prompt in ({"x": 500, "y": 500}, {"box": [480, 480, 520, 520]}):
        task_id = str(uuid4())
        response = auth.post(
            f"/patches/{patch['id']}/ai", json={"id": task_id, "job_id": 2, **prompt}
        )
        assert response.status_code == 202
        with session_factory()() as db:
            assert json.loads(db.get(AiTask, task_id).input)["nm_per_px"] == calibration
        assert process_next({DEFAULT_AI_MODEL.name: model})
        with session_factory()() as db:
            assert db.get(AiTask, task_id).status == "done"
        assert len(fetched) == len(encoded) == count
    assert len(auth.get("/patches/current").json()["elements"]) == 2


def test_tile_overlap_preserves_objects_across_core_boundaries_and_box_offsets(fake_model):
    create, fetched, encoded, prompts = fake_model
    model = create()
    request = {**REQUEST, "width": 1024, "height": 768}
    for region in regions(1024, 768):
        model.prepare(tile_request(request, region))
    count = len(encoded)
    polygon = model.predict({**request, "x": 383, "y": 200})
    assert min(x for x, _ in polygon["points"]) == 353
    assert max(x for x, _ in polygon["points"]) == 413
    polygon = model.predict({**request, "box": [350, 200, 450, 300]})
    np.testing.assert_array_equal(prompts[-1]["box"], [30, 200, 130, 300])
    assert min(x for x, _ in polygon["points"]) == 350
    assert max(x for x, _ in polygon["points"]) == 449
    polygon = model.predict({**request, "box": [20, 20, 900, 700]})
    assert max(x for x, _ in polygon["points"]) == 899
    assert model.predictor.original_size == (768, 1024)
    assert len(encoded) == len(fetched) == count


def test_point_touching_tile_boundary_reuses_prepared_overview(fake_model):
    create, _, encoded, _ = fake_model
    model = create()
    request = {**REQUEST, "width": 1024, "height": 768, "x": 383, "y": 200}
    for region in regions(1024, 768):
        model.prepare(tile_request(request, region))

    def predict(**kwargs):
        h, w = model.predictor.original_size
        mask = np.zeros((1, h, w), dtype=bool)
        mask[0, 190:211, 350 : min(w, 700)] = True
        return mask, np.array([0.9]), None

    model.predictor.predict = predict
    count = len(encoded)
    polygon = model.predict(request)
    assert max(x for x, _ in polygon["points"]) == 699
    assert len(encoded) == count


def test_point_falls_back_to_lower_scoring_mask_that_fits_the_tile(fake_model):
    create, _, _, _ = fake_model
    model = create()
    # Too large for a whole-image fallback, so only the point's tile is available.
    request = {**REQUEST, "width": 5000, "height": 5000, "x": 1000, "y": 1000}
    leaking = 1

    def predict(**kwargs):
        h, w = model.predictor.original_size
        masks = np.zeros((3, h, w), dtype=bool)
        x, y = np.round(kwargs["point_coords"][0]).astype(int)
        for i, r in enumerate((5, 20)):
            masks[i, y - r : y + r + 1, x - r : x + r + 1] = True
        masks[3 - leaking :] = True
        return masks, np.array([0.3, 0.9, 0.95]), None

    model.predictor.predict = predict
    polygon = model.predict(request)
    assert min(x for x, _ in polygon["points"]) == 980

    leaking = 2
    polygon = model.predict(request)
    assert min(x for x, _ in polygon["points"]) == 995

    leaking = 3
    with pytest.raises(ValueError, match="extends beyond the tile"):
        model.predict(request)


def test_point_missed_by_its_tile_still_tries_the_whole_image(fake_model):
    create, _, _, _ = fake_model
    model = create()
    request = {**REQUEST, "width": 1024, "height": 768, "x": 383, "y": 200}

    def predict(**kwargs):
        h, w = model.predictor.original_size
        x, y = np.round(kwargs["point_coords"][0]).astype(int)
        mask = np.zeros((1, h, w), dtype=bool)
        if (h, w) == (768, 1024):
            mask[0, y - 10 : y + 11, x - 30 : x + 31] = True
        return mask, np.array([0.9]), None

    model.predictor.predict = predict
    polygon = model.predict(request)
    assert min(x for x, _ in polygon["points"]) == 353
    assert max(x for x, _ in polygon["points"]) == 413

    model.predictor.predict = lambda **_: (np.zeros((1, 768, 1024), dtype=bool), [0.9], None)
    with pytest.raises(ValueError, match="No structure found at this point"):
        model.predict(request)


@pytest.mark.parametrize(
    "width,height,scale",
    [(1024, 768, None), (4096, 3072, 5), (1024, 768, 12), (5000, 3000, 0.48828125)],
)
def test_box_selection_preserves_grid_coverage(width, height, scale):
    rng = Random(19)
    full = (0, 0, width, height)
    tiles = [region for region in regions(width, height, scale) if region != full]
    for _ in range(300):
        x0, x1 = sorted(rng.sample(range(width + 1), 2))
        y0, y1 = sorted(rng.sample(range(height + 1), 2))
        fitting = [
            (x, y, w, h)
            for x, y, w, h in tiles
            if x <= x0 and y <= y0 and x1 <= x + w and y1 <= y + h
        ]
        request = {
            **REQUEST,
            "width": width,
            "height": height,
            "nm_per_px": scale,
            "box": [x0, y0, x1, y1],
        }
        if fitting:
            assert prompt_regions(request)[0] in fitting
        elif max(width, height) <= 4096:
            assert prompt_regions(request) == [full]
        else:
            with pytest.raises(ValueError, match="larger than the available tiles"):
                prompt_regions(request)


@pytest.mark.parametrize("stage", ["save", "load"])
def test_embedding_lock_retry_does_not_repeat_encoding(fake_model, busy_db, stage):
    create, fetched, encoded, _ = fake_model
    writer, blocked = busy_db
    model = create()
    request = tile_request(REQUEST, (0, 0, 320, 300))
    if stage == "load":
        model.prepare(request)
        model = create()
        writer.execute("BEGIN EXCLUSIVE")
    else:
        encode = model.predictor.set_image

        def encode_then_lock(pixels):
            encode(pixels)
            writer.execute("BEGIN IMMEDIATE")

        model.predictor.set_image = encode_then_lock
    with ThreadPoolExecutor(1) as pool:
        future = pool.submit(model.prepare, request)
        try:
            assert blocked.wait(3), "Embedding access did not encounter the held lock"
            assert not future.done()
        finally:
            writer.rollback()
        future.result(timeout=3)
    assert len(fetched) == len(encoded) == 1
    with session_factory()() as db:
        row = db.scalar(select(AiEmbedding))
        assert row.status == "ready" and row.data


def test_encoding_does_not_hold_database_lock(fake_model):
    create, _, _, _ = fake_model
    model = create()
    encode = model.predictor.set_image

    def encode_with_writer(pixels):
        from simple_annotator.annotations import lock

        with session_factory()() as db:
            lock(db)
            db.commit()
        encode(pixels)

    model.predictor.set_image = encode_with_writer
    model.prepare(tile_request(REQUEST, (0, 0, 320, 300)))
    with session_factory()() as db:
        assert db.scalar(select(AiEmbedding.status)) == "ready"


def test_empty_mask_and_wrong_image_size_are_clear_errors(fake_model, monkeypatch):
    create, _, _, _ = fake_model
    model = create()
    model.predictor.predict = lambda **_: (np.zeros((1, 300, 320), dtype=bool), [], None)
    with pytest.raises(ValueError, match="No structure found in this box"):
        model.predict({**REQUEST, "box": [17, 23, 57, 43]})
    output = io.BytesIO()
    Image.new("RGB", (10, 10)).save(output, format="PNG")
    monkeypatch.setattr(segmenter, "fetch_image", lambda *_: output.getvalue())
    with pytest.raises(ValueError, match="Image dimensions changed"):
        model.prepare(tile_request({**REQUEST, "item_id": "changed"}, (0, 0, 320, 300)))


def test_worker_prepares_each_tile_once_and_prioritizes_prompts(auth, fake_model):
    import json
    import time

    create, fetched, _, _ = fake_model
    patch = auth.get("/patches/current").json()
    user_id = auth.get("/me").json()["id"]
    with session_factory()() as db:
        tile = db.get(Patch, patch["id"])
    request = {
        **REQUEST,
        "item_id": "placeholder",
        "left": tile.left,
        "top": tile.top,
        "width": 1024,
        "height": 1024,
        "x": 200,
        "y": 200,
    }
    with session_factory()() as db:
        db.add(
            AiTask(
                id="priority",
                user_id=user_id,
                patch_id=patch["id"],
                job_id=2,
                status="queued",
                created=time.time(),
                input=json.dumps(request),
            )
        )
        db.commit()
    model = create()
    assert process_next({DEFAULT_AI_MODEL.name: model})
    with session_factory()() as db:
        assert db.get(AiTask, "priority").status == "done"
        assert "queued" in set(db.scalars(select(AiEmbedding.status)))
    assert len(auth.get("/patches/current").json()["elements"]) == 1
    for _ in range(20):
        if not process_next({DEFAULT_AI_MODEL.name: model}):
            break
    else:
        pytest.fail("Embedding preparation did not finish")
    with session_factory()() as db:
        rows = db.scalars(select(AiEmbedding)).all()
        assert all(row.status == "ready" and row.data for row in rows)
    assert len(fetched) == len(regions(1024, 1024))
    assert process_next({DEFAULT_AI_MODEL.name: create()}) is False


def test_local_checkpoint_must_exist_and_match_its_hash(tmp_path):
    import xxhash

    path = tmp_path / "weights.pt"
    model = AiModel("local", "vit_l", str(path), xxhash.xxh128(b"weights").hexdigest())
    with pytest.raises(segmenter.ModelUnavailable, match="not found"):
        segmenter.checkpoint(model)
    path.write_bytes(b"weights")
    assert segmenter.checkpoint(model) == path
    path.write_bytes(b"retrained")
    with pytest.raises(segmenter.ModelUnavailable, match="changed"):
        segmenter.checkpoint(model)


def test_bad_download_leaves_no_cached_checkpoint(tmp_path, monkeypatch):
    from contextlib import contextmanager
    from types import SimpleNamespace

    @contextmanager
    def stream(*_, **__):
        yield SimpleNamespace(raise_for_status=lambda: None, iter_bytes=lambda: [b"corrupt"])

    monkeypatch.setenv("SIMPLE_ANNOTATOR_MODEL_DIR", str(tmp_path))
    monkeypatch.setattr(segmenter.httpx, "stream", stream)
    model = AiModel("remote", "vit_l", "https://example.invalid/w.pt", "0" * 32)
    with pytest.raises(segmenter.ModelUnavailable, match="wrong checksum"):
        segmenter.checkpoint(model)
    assert list(tmp_path.iterdir()) == []


def test_corrupt_cached_checkpoint_is_downloaded_again(tmp_path, monkeypatch):
    from contextlib import contextmanager
    from types import SimpleNamespace

    import xxhash

    @contextmanager
    def stream(*_, **__):
        yield SimpleNamespace(raise_for_status=lambda: None, iter_bytes=lambda: [b"weights"])

    monkeypatch.setenv("SIMPLE_ANNOTATOR_MODEL_DIR", str(tmp_path))
    monkeypatch.setattr(segmenter.httpx, "stream", stream)
    digest = xxhash.xxh128(b"weights").hexdigest()
    model = AiModel("remote", "vit_l", "https://example.invalid/w.pt", digest)
    (tmp_path / "remote.pt").write_bytes(b"trunc")
    assert segmenter.checkpoint(model).read_bytes() == b"weights"


def test_pinched_masks_become_the_largest_valid_polygon():
    import shapely

    mask = np.zeros((40, 40), np.uint8)
    mask[5:25, 5:25] = 1
    mask[25:29, 25:29] = 1
    mask[10:15, 5:12] = 0
    outline = segmenter.mask_polygon(mask, (100, 200))
    shape = shapely.Polygon(outline["points"], outline["holes"])
    assert shape.is_valid
    assert shape.bounds == (105, 205, 124, 224)
    assert shape.area == pytest.approx(19 * 19 - 5 * 7, abs=8)
