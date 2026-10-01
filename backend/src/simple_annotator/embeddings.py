import hashlib
import json
import logging
import math
import time

from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.exc import OperationalError

from simple_annotator.config import AI_MODELS, GIRDER_API_URL, AiModel
from simple_annotator.db import retry_sqlite_busy, session_factory
from simple_annotator.models import AiEmbedding, Patch

TILE_SIZE = 384
HALO = 64
TILE_NM = 3000
HALO_NM = 500
# Inference memory limits are independent of the configurable image display threshold.
FULL_EMBEDDING_MAX = 4096
MAX_TILE_CORE = 3072
# Change this when pixel preprocessing or embedding serialization change.
RECIPE = "rgb-u8:npz-f32-v1"
log = logging.getLogger(__name__)


def tile_shape(nm_per_px: float | None = None, extent: int = FULL_EMBEDDING_MAX) -> tuple[int, int]:
    if nm_per_px is None or not math.isfinite(nm_per_px) or nm_per_px <= 0:
        return TILE_SIZE, HALO
    # Bound both the tile count at coarse scales and memory for very fine scales.
    limit = FULL_EMBEDDING_MAX if extent <= FULL_EMBEDDING_MAX else MAX_TILE_CORE
    size = max(64, round(min(limit, TILE_NM / nm_per_px)))
    halo = round(min((FULL_EMBEDDING_MAX - size) // 2, HALO_NM / nm_per_px))
    return size, halo


def tile_at(
    x: float, y: float, width: int, height: int, nm_per_px: float | None = None
) -> tuple[int, int, int, int]:
    size, halo = tile_shape(nm_per_px, max(width, height))
    if max(width, height) <= size and max(width, height) <= FULL_EMBEDDING_MAX:
        return 0, 0, width, height
    left = int(x) // size * size
    top = int(y) // size * size
    right, bottom = min(width, left + size + halo), min(height, top + size + halo)
    left, top = max(0, left - halo), max(0, top - halo)
    return left, top, right - left, bottom - top


def regions(
    width: int, height: int, nm_per_px: float | None = None, whole_image: bool = False
) -> list[tuple[int, int, int, int]]:
    if whole_image and max(width, height) <= FULL_EMBEDDING_MAX:
        return [(0, 0, width, height)]
    size, _ = tile_shape(nm_per_px, max(width, height))
    tiles = [
        tile_at(x, y, width, height, nm_per_px)
        for y in range(0, height, size)
        for x in range(0, width, size)
    ]
    # Bound the whole-image fallback; whole slides must stay tiled.
    if max(width, height) <= FULL_EMBEDDING_MAX:
        tiles.append((0, 0, width, height))
    return list(dict.fromkeys(tiles))


def tile_request(request: dict, region: tuple[int, int, int, int]) -> dict:
    x, y, width, height = region
    return {
        "model": request["model"],
        "item_id": request["item_id"],
        "left": request["left"] + x,
        "top": request["top"] + y,
        "width": width,
        "height": height,
        "source": GIRDER_API_URL.rstrip("/"),
        "recipe": f"{AI_MODELS[request['model']].xxh128}:{RECIPE}",
    }


def prompt_regions(request: dict) -> list[tuple[int, int, int, int]]:
    width, height = request["width"], request["height"]
    box = request.get("box")
    full = (0, 0, width, height)
    if AI_MODELS[request["model"]].whole_image and max(width, height) <= FULL_EMBEDDING_MAX:
        return [full]
    center = ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2) if box else (request["x"], request["y"])
    first = tile_at(*center, width, height, request.get("nm_per_px"))
    candidates = (
        [first, full] if first != full and max(width, height) <= FULL_EMBEDDING_MAX else [first]
    )
    if box:
        x0, y0, x1, y1 = box
        # On this regular grid, no other tile can contain a box that its center tile cannot.
        for region in candidates:
            x, y, w, h = region
            if x <= x0 and y <= y0 and x1 <= x + w and y1 <= y + h:
                return [region]
        raise ValueError("Box is larger than the available tiles. Use a smaller box or the brush.")
    return candidates


def embedding_id(request: dict) -> str:
    return hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()


def queue_image(patch_id: int, nm_per_px: float | None, models: list[AiModel]) -> None:
    try:
        _queue_image(patch_id, nm_per_px, models)
    except OperationalError:
        log.exception("Could not queue embeddings for patch %s; preparation deferred", patch_id)


@retry_sqlite_busy(attempts=3)
def _queue_image(patch_id: int, nm_per_px: float | None, models: list[AiModel]) -> None:
    with session_factory()() as db:
        patch = db.get(Patch, patch_id)
        requests = {}
        for model in models:
            source = {
                "model": model.name,
                "item_id": patch.girder_item_id,
                "left": patch.left,
                "top": patch.top,
            }
            for region in regions(patch.width, patch.height, nm_per_px, model.whole_image):
                request = tile_request(source, region)
                requests[embedding_id(request)] = request
        existing = set(
            db.scalars(
                select(AiEmbedding.id).where(
                    AiEmbedding.id.in_(requests), AiEmbedding.status != "failed"
                )
            )
        )
        pending = [
            {"id": key, "input": json.dumps(request), "status": "queued", "created": time.time()}
            for key, request in requests.items()
            if key not in existing
        ]
        if not pending:
            return
        statement = insert(AiEmbedding).values(pending)
        db.execute(
            statement.on_conflict_do_update(
                index_elements=[AiEmbedding.id],
                set_={"status": "queued", "error": None},
                where=AiEmbedding.status == "failed",
            )
        )
        db.commit()


@retry_sqlite_busy
def load_embedding(key: str) -> bytes | None:
    with session_factory()() as db:
        return db.scalar(
            select(AiEmbedding.data).where(AiEmbedding.id == key, AiEmbedding.status == "ready")
        )


@retry_sqlite_busy
def save_embedding(request: dict, data: bytes) -> None:
    with session_factory()() as db:
        statement = insert(AiEmbedding).values(
            id=embedding_id(request),
            input=json.dumps(request),
            status="ready",
            created=time.time(),
            data=data,
            error=None,
        )
        db.execute(
            statement.on_conflict_do_update(
                index_elements=[AiEmbedding.id],
                set_={"data": statement.excluded.data, "status": "ready", "error": None},
            )
        )
        db.commit()
