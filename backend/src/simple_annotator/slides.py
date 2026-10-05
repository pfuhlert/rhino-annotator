import io
import logging
import math
import random

import numpy as np
from PIL import Image
from sqlalchemy import func, select, update
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
    folder_images,
    get_item,
    girder_enabled,
    image_info,
    image_nm_per_px,
    is_elmi_folder,
    thumbnail,
)
from simple_annotator.models import Patch, PatchVisit, Slide, User
from simple_annotator.tiling import grid, is_colored, split, tissue_mask, tissue_regions

PLACEHOLDER_SIZE = FULL_IMAGE_MAX + CROP_SIZE
DETECTION_SIDE = 2048
log = logging.getLogger(__name__)


class UnreadableImage(Exception):
    pass


def _signature(slide: Slide) -> str:
    if slide.histo:
        params = (REGION_MAX_UM, TILE_OVERLAP_UM, REGION_PAD_UM, REGION_MERGE_UM)
        return f"v2:regions:{':'.join(f'{v:g}' for v in params)}:{TISSUE_MIN_AREA_UM2:g}"
    if max(slide.width, slide.height) <= FULL_IMAGE_MAX:
        return "v1:whole"
    return f"v1:{CROP_SIZE}:{CROP_SIZE - _crop_overlap()}:all"


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
    rgb = None
    mm_x = info.get("mm_x")
    if mm_x and mm_x > 0 and not is_elmi_folder(item.get("folderId")):
        rgb = _rgb(item_id)
        if is_colored(rgb):
            slide.histo, slide.nm_per_px = True, float(mm_x) * 1e6
    slide.grid = _signature(slide)
    width, height = slide.width, slide.height
    if slide.histo:
        um_per_px = slide.nm_per_px / 1000
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


def _first_pass(db: Session, items: list[dict], counts: dict[int, int]) -> int:
    # Once every image has its tiles, skip the passes every tile has already completed.
    ids = {item["_id"] for item in items}
    rows = db.execute(
        select(Patch.girder_item_id, Patch.id)
        .join(Slide, (Slide.item_id == Patch.girder_item_id) & (Slide.grid == Patch.grid))
        .where(Patch.girder_item_id.in_(ids))
    ).all()
    if {item_id for item_id, _ in rows} != ids:
        return 1
    return 1 + min(counts.get(patch_id, 0) for _, patch_id in rows)


def next_tile(db: Session, user: User, folder_id: str, current_item: str | None) -> Patch:
    if not girder_enabled() or folder_id == PLACEHOLDER_FOLDER:
        items = [get_item(PLACEHOLDER_FOLDER)]
    else:
        items = folder_images(folder_id)
    items = random.sample(items, len(items))
    items.sort(key=lambda item: item["_id"] != current_item)
    counts = dict(
        db.execute(
            select(PatchVisit.patch_id, func.count())
            .where(PatchVisit.user_id == user.id)
            .group_by(PatchVisit.patch_id)
        ).all()
    )
    slides: dict[str, Slide | None] = {}
    reason = ""
    n = _first_pass(db, items, counts)
    while True:
        for item in items:
            if item["_id"] not in slides:
                try:
                    slides[item["_id"]] = ensure_slide(db, item)
                except UnreadableImage as e:
                    slides[item["_id"]] = None
                    reason = reason or str(e)
            slide = slides[item["_id"]]
            if slide is None:
                continue
            for tile in _tiles(db, slide):
                if counts.get(tile.id, 0) < n:
                    return tile
        if not any(slides.values()):
            detail = f" Girder says: {reason}" if reason else ""
            raise RuntimeError(
                f"None of the {len(items)} images in this dataset can be read by the image "
                f"server.{detail}"
            )
        n += 1


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
    visited = set(
        db.scalars(
            select(PatchVisit.patch_id).where(
                PatchVisit.user_id == user.id, PatchVisit.patch_id.in_([t.id for t in tiles])
            )
        )
    )
    return {
        "name": slide.name,
        "width": slide.width,
        "height": slide.height,
        "thumbnail_url": f"/patches/{patch.id}/slide-thumbnail",
        "tiles": [[t.left, t.top, t.width, t.height, t.id in visited] for t in tiles],
        "current": next(i for i, t in enumerate(tiles) if t.id == patch.id),
    }
