import math
import re
from collections import Counter

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from simple_annotator.auth import current_user
from simple_annotator.db import get_db
from simple_annotator.girder import PLACEHOLDER_FOLDER, folder_images, get_item, girder_enabled
from simple_annotator.models import Annotation, Patch, PatchVisit, Slide, User

router = APIRouter(prefix="/images")

POWERS = (1.25, 2.5, 5, 10, 20, 40, 60, 100)
# Girder's histology pixel size is 10x too small, so its magnification is 10x too large.
MAGNIFICATION_ERROR = 10


def natural_key(text: str) -> list:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", text)]


def _meta(item: dict) -> dict:
    return item.get("meta") or {}


def group_key(item: dict) -> str:
    return str(_meta(item).get("case_id") or item.get("folder_name") or "")


def staining(item: dict) -> str | None:
    return _meta(item).get("staining") or None


def magnification(item: dict) -> float | None:
    value = _meta(item).get("image_magnification")
    if not isinstance(value, (int, float)) or value <= 0:
        return None
    actual = value / MAGNIFICATION_ERROR
    return min(POWERS, key=lambda power: abs(math.log(power / actual)))


def matches(item: dict, stains: list[str | None]) -> bool:
    return not stains or staining(item) in stains


def ordered_items(folder_id: str) -> list[dict]:
    if not girder_enabled() or folder_id == PLACEHOLDER_FOLDER:
        items = [get_item(PLACEHOLDER_FOLDER)]
    else:
        try:
            items = folder_images(folder_id)
        except RuntimeError as e:
            raise HTTPException(400, str(e)) from e
    # The exact group breaks natural-sort ties ("case-2", "case-02") so groups stay contiguous.
    return sorted(
        items,
        key=lambda it: (natural_key(group_key(it)), group_key(it), natural_key(it["name"])),
    )


@router.get("")
def list_images(user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    items = ordered_items(user.last_folder_id or PLACEHOLDER_FOLDER)
    ids = [item["_id"] for item in items]
    current_grid = (Slide.item_id == Patch.girder_item_id) & (Slide.grid == Patch.grid)
    regions = dict(
        db.execute(
            select(Patch.girder_item_id, func.count())
            .join(Slide, current_grid)
            .where(Patch.girder_item_id.in_(ids))
            .group_by(Patch.girder_item_id)
        ).all()
    )
    visited = dict(
        db.execute(
            select(Patch.girder_item_id, func.count(func.distinct(Patch.id)))
            .join(Slide, current_grid)
            .join(PatchVisit, PatchVisit.patch_id == Patch.id)
            .where(PatchVisit.user_id == user.id, Patch.girder_item_id.in_(ids))
            .group_by(Patch.girder_item_id)
        ).all()
    )
    annotations = dict(
        db.execute(
            select(Annotation.item_id, func.count())
            .where(Annotation.user_id == user.id, Annotation.item_id.in_(ids))
            .group_by(Annotation.item_id)
        ).all()
    )
    stains = Counter(staining(item) for item in items)
    return {
        "items": [
            {
                "id": item["_id"],
                "name": item["name"],
                "group": group_key(item),
                "staining": staining(item),
                "magnification": magnification(item),
                "regions": regions.get(item["_id"]),
                "visited": visited.get(item["_id"], 0),
                "annotations": annotations.get(item["_id"], 0),
            }
            for item in items
        ],
        "stains": [{"name": name, "count": n} for name, n in stains.most_common()],
    }
