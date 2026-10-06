import io
import logging
import math
from typing import Literal

import numpy as np
from PIL import Image
from sqlalchemy import select, update
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.orm import Session

from simple_annotator.config import (
    CROP_OVERLAP,
    CROP_SIZE,
    FULL_IMAGE_MAX,
    REGION_MAX_UM,
    REGION_MERGE_UM,
    REGION_PAD_UM,
    TILE_OVERLAP_UM,
    TISSUE_MIN_AREA_UM2,
)
from simple_annotator.girder import (
    PLACEHOLDER_FOLDER,
    get_item,
    girder_enabled,
    image_info,
    image_nm_per_px,
    is_elmi_folder,
    ome_nm_per_px,
    thumbnail,
)
from simple_annotator.images import matches, ordered_items
from simple_annotator.models import Patch, PatchVisit, Slide, User
from simple_annotator.tiling import grid, split, tissue_mask, tissue_regions

PLACEHOLDER_SIZE = FULL_IMAGE_MAX + CROP_SIZE
DETECTION_SIDE = 2048
log = logging.getLogger(__name__)


class UnreadableImage(Exception):
    pass


def _signature(slide: Slide) -> str:
    if slide.histo:
        params = (REGION_MAX_UM, TILE_OVERLAP_UM, REGION_PAD_UM, REGION_MERGE_UM)
        return f"v3:regions:{':'.join(f'{v:g}' for v in params)}:{TISSUE_MIN_AREA_UM2:g}"
    if max(slide.width, slide.height) <= FULL_IMAGE_MAX:
        return "v1:whole"
    # v1 grids include gray-stained histology slides that are now tissue regions.
    return f"v2:{CROP_SIZE}:{CROP_SIZE - _crop_overlap()}:all"


def _crop_overlap() -> int:
    return min(CROP_OVERLAP, CROP_SIZE // 2)


def _rgb(item_id: str) -> np.ndarray:
    data = thumbnail(item_id, DETECTION_SIDE)
    return np.asarray(Image.open(io.BytesIO(data)).convert("RGB"))


def _build(item: dict) -> tuple[Slide, list[tuple[int, int, int, int]]]:
    item_id = item["_id"]
    if item_id == PLACEHOLDER_FOLDER or not girder_enabled():
        info = {"sizeX": PLACEHOLDER_SIZE, "sizeY": PLACEHOLDER_SIZE}
    else:
        info, reason = image_info(item_id)
        if info is None:
            raise UnreadableImage(reason)
    tile = int(info.get("tileWidth", 256))
    extent = max(int(info["sizeX"]), int(info["sizeY"]))
    levels = info.get("levels") or max(0, math.ceil(math.log2(extent / tile))) + 1
    slide = Slide(
        item_id=item_id,
        name=item.get("name", item_id),
        width=int(info["sizeX"]),
        height=int(info["sizeY"]),
        nm_per_px=None,
        histo=False,
        tile_width=tile,
        tile_height=int(info.get("tileHeight", tile)),
        levels=int(levels),
    )
    nm_per_px = None if is_elmi_folder(item.get("folderId")) else ome_nm_per_px(item_id)
    if nm_per_px:
        slide.histo, slide.nm_per_px = True, nm_per_px
    slide.grid = _signature(slide)
    width, height = slide.width, slide.height
    if slide.histo:
        um_per_px = slide.nm_per_px / 1000
        rgb = _rgb(item_id)
        scale = rgb.shape[1] / width
        mask = tissue_mask(rgb, um_per_px / scale, TISSUE_MIN_AREA_UM2)
        merge = round(REGION_MERGE_UM / um_per_px * scale)
        boxes = tissue_regions(mask, scale, width, height, merge, round(REGION_PAD_UM / um_per_px))
        if not boxes:
            log.warning("No tissue detected in %s; using the whole slide", item_id)
            boxes = [[0, 0, width, height]]
        size, overlap = round(REGION_MAX_UM / um_per_px), round(TILE_OVERLAP_UM / um_per_px)
        tiles = [chunk for box in boxes for chunk in split(box, size, overlap)]
    elif max(width, height) <= FULL_IMAGE_MAX:
        tiles = [(0, 0, width, height)]
    else:
        tiles = grid(width, height, CROP_SIZE, CROP_SIZE - _crop_overlap())
    return slide, tiles


def ensure_slide(db: Session, item: dict) -> Slide:
    slide = db.get(Slide, item["_id"])
    if slide and slide.grid == _signature(slide):
        return slide
    built, tiles = _build(item)
    fields = {c.key: getattr(built, c.key) for c in Slide.__table__.columns}
    # A concurrent first visit may build the same grid; only the writer that wins adds tiles.
    if slide is None:
        won = db.execute(insert(Slide).values(fields).on_conflict_do_nothing()).rowcount
    else:
        won = db.execute(
            update(Slide)
            .where(Slide.item_id == slide.item_id, Slide.grid == slide.grid)
            .values(fields)
        ).rowcount
    if won:
        # Tiles of this grid may outlive their slide row; never add the same tile twice.
        existing = set(
            db.execute(
                select(Patch.left, Patch.top, Patch.width, Patch.height).where(
                    Patch.girder_item_id == built.item_id, Patch.grid == built.grid
                )
            ).tuples()
        )
        db.add_all(
            Patch(girder_item_id=built.item_id, left=x, top=y, width=w, height=h, grid=built.grid)
            for x, y, w, h in tiles
            if (x, y, w, h) not in existing
        )
    db.commit()
    return db.get(Slide, built.item_id, populate_existing=True)


def _tiles(db: Session, slide: Slide) -> list[Patch]:
    return db.scalars(
        select(Patch)
        .where(Patch.girder_item_id == slide.item_id, Patch.grid == slide.grid)
        .order_by(Patch.top, Patch.left)
    ).all()


def _visited(db: Session, user: User, tiles: list[Patch]) -> set[int]:
    return set(
        db.scalars(
            select(PatchVisit.patch_id).where(
                PatchVisit.user_id == user.id, PatchVisit.patch_id.in_([t.id for t in tiles])
            )
        )
    )


def step(
    db: Session,
    folder_id: str,
    current: Patch | None,
    direction: Literal[1, -1],
    stains: list[str | None],
) -> Patch:
    items = ordered_items(folder_id)
    ids = [item["_id"] for item in items]
    pos = ids.index(current.girder_item_id) if current and current.girder_item_id in ids else None
    if pos is not None and matches(items[pos], stains):
        try:
            tiles = _tiles(db, ensure_slide(db, items[pos]))
        except UnreadableImage:
            tiles = []
        i = next((k for k, t in enumerate(tiles) if t.id == current.id), None)
        if tiles and i is None:
            return tiles[0 if direction > 0 else -1]
        if i is not None and 0 <= i + direction < len(tiles):
            return tiles[i + direction]
    candidates = [item for item in items if matches(item, stains)]
    if not candidates:
        raise RuntimeError("No images in this dataset match the stain filter.")
    start = pos if pos is not None else (-1 if direction > 0 else 0)
    reason = ""
    for k in range(1, len(items) + 1):
        item = items[(start + direction * k) % len(items)]
        if not matches(item, stains):
            continue
        try:
            tiles = _tiles(db, ensure_slide(db, item))
        except UnreadableImage as e:
            reason = reason or str(e)
            continue
        return tiles[0 if direction > 0 else -1]
    detail = f" Girder says: {reason}" if reason else ""
    raise RuntimeError(
        f"None of the {len(candidates)} images in this dataset can be read by the image "
        f"server.{detail}"
    )


def open_item(db: Session, user: User, item: dict) -> Patch:
    tiles = _tiles(db, ensure_slide(db, item))
    visited = _visited(db, user, tiles)
    return next((t for t in tiles if t.id not in visited), tiles[0])


def patch_scale(db: Session, patch: Patch) -> tuple[Slide, float | None]:
    # Legacy random crops predate slide rows. The Girder item supplies the folder that decides
    # ELMI and the name shown on the map.
    slide = db.get(Slide, patch.girder_item_id) or ensure_slide(db, get_item(patch.girder_item_id))
    return slide, slide.nm_per_px if slide.histo else image_nm_per_px(patch.girder_item_id)


def slide_view(db: Session, user: User, patch: Patch) -> dict | None:
    slide = db.get(Slide, patch.girder_item_id)
    if not patch.grid or not slide or slide.grid != patch.grid:
        return None
    tiles = _tiles(db, slide)
    if len(tiles) == 1 and (patch.width, patch.height) == (slide.width, slide.height):
        return None
    visited = _visited(db, user, tiles)
    return {
        "name": slide.name,
        "width": slide.width,
        "height": slide.height,
        "thumbnail_url": f"/patches/{patch.id}/slide-thumbnail",
        "tiles": [[t.left, t.top, t.width, t.height, t.id in visited] for t in tiles],
        "current": next(i for i, t in enumerate(tiles) if t.id == patch.id),
    }
