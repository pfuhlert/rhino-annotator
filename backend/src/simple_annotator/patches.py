from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, NonNegativeInt, PositiveInt
from sqlalchemy import select
from sqlalchemy.orm import Session

from simple_annotator.annotations import (
    Changes,
    apply_changes,
    element_json,
    lock,
    require_patch,
    times,
    visible,
)
from simple_annotator.auth import current_user, set_folder, user_stains
from simple_annotator.config import FULL_IMAGE_MAX, job_ai_model
from simple_annotator.db import get_db
from simple_annotator.embeddings import queue_image
from simple_annotator.girder import PLACEHOLDER_FOLDER, thumbnail, tile
from simple_annotator.images import ordered_items
from simple_annotator.models import Job, Patch, PatchVisit, Slide, User
from simple_annotator.slides import ensure_slide, open_item, patch_scale, slide_view, step, tile_at

router = APIRouter(prefix="/patches")


def _dump(
    db: Session, user: User, patch: Patch, visit: PatchVisit, slide: Slide, nm_per_px: float | None
) -> dict:
    rows = visible(db, user.id, patch)
    return {
        "id": patch.id,
        "item_id": patch.girder_item_id,
        "job_id": user.last_job_id,
        "folder_id": visit.folder_id,
        "image": {
            "width": patch.width,
            "height": patch.height,
            "left": patch.left,
            "top": patch.top,
            "slide_width": slide.width,
            "slide_height": slide.height,
            "tile_width": slide.tile_width,
            "tile_height": slide.tile_height,
            "levels": slide.levels,
            "tile_url": f"/patches/{patch.id}/tiles/{{z}}/{{x}}/{{y}}",
            "prepare_view": _prepares_view(patch),
        },
        "nm_per_px": nm_per_px,
        "elements": [element_json(a, patch) for a in rows],
        "times": times(rows),
        "slide": slide_view(db, user, patch),
    }


def _prepares_view(patch: Patch) -> bool:
    # Large tissue regions prepare AI tiles around the viewed area instead of all at once.
    return max(patch.width, patch.height) > FULL_IMAGE_MAX


def _queue_ai(
    db: Session,
    user: User,
    patch: Patch,
    background: BackgroundTasks,
    slide: Slide,
    nm_per_px: float | None,
    within: tuple[int, int, int, int] | None = None,
) -> None:
    if within is None and _prepares_view(patch):
        return
    job = db.get(Job, user.last_job_id) if user.last_job_id else None
    histo = slide.histo
    models = list(dict.fromkeys([job_ai_model(None, histo), job_ai_model(job and job.name, histo)]))
    background.add_task(queue_image, patch.id, nm_per_px, models, histo, within)


def _open(db: Session, user: User, visit: PatchVisit, background: BackgroundTasks) -> dict:
    user.current_visit_id = visit.id
    patch = db.get(Patch, visit.patch_id)
    assert patch
    db.commit()
    slide, nm_per_px = patch_scale(db, patch)
    result = _dump(db, user, patch, visit, slide, nm_per_px)
    _queue_ai(db, user, patch, background, slide, nm_per_px)
    return result


def _folder_id(user: User) -> str:
    if not user.last_folder_id:
        user.last_folder_id = PLACEHOLDER_FOLDER
    return user.last_folder_id


def _step(db: Session, user: User, direction: Literal[1, -1], background: BackgroundTasks) -> dict:
    folder_id = _folder_id(user)
    visit = _cursor_visit(db, user) or _last_in_folder(db, user)
    current = db.get(Patch, visit.patch_id) if visit else None
    try:
        patch = step(db, folder_id, current, direction, user_stains(user))
    except RuntimeError as e:
        raise HTTPException(400, str(e)) from e
    return _record(db, user, patch, folder_id, background)


def _record(
    db: Session, user: User, patch: Patch, folder_id: str, background: BackgroundTasks
) -> dict:
    visit = PatchVisit(user_id=user.id, patch_id=patch.id, folder_id=folder_id)
    db.add(visit)
    db.flush()
    return _open(db, user, visit, background)


def _cursor_visit(db: Session, user: User) -> PatchVisit | None:
    visit = db.get(PatchVisit, user.current_visit_id) if user.current_visit_id else None
    if visit and visit.folder_id == _folder_id(user):
        return visit
    return None


def _last_in_folder(db: Session, user: User) -> PatchVisit | None:
    return db.scalar(
        select(PatchVisit)
        .where(PatchVisit.user_id == user.id, PatchVisit.folder_id == _folder_id(user))
        .order_by(PatchVisit.id.desc())
        .limit(1)
    )


@router.get("/current")
def current_patch(
    background: BackgroundTasks, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    visit = _cursor_visit(db, user) or _last_in_folder(db, user)
    return _open(db, user, visit, background) if visit else _step(db, user, 1, background)


@router.get("/next")
def next_patch(
    background: BackgroundTasks, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    return _step(db, user, 1, background)


@router.get("/prev")
def prev_patch(
    background: BackgroundTasks, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    return _step(db, user, -1, background)


class View(BaseModel):
    left: NonNegativeInt
    top: NonNegativeInt
    width: PositiveInt
    height: PositiveInt


class OpenImage(BaseModel):
    item_id: str
    # A shared link names its dataset and the visible slide rectangle.
    folder_id: str | None = None
    view: View | None = None


@router.post("/open")
def open_image(
    body: OpenImage,
    background: BackgroundTasks,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    if body.folder_id:
        set_folder(user, body.folder_id)
    folder_id = _folder_id(user)
    item = next((it for it in ordered_items(folder_id) if it["_id"] == body.item_id), None)
    if not item:
        raise HTTPException(404, "image not in this dataset")
    if body.view is None:
        patch = open_item(db, user, item)
    else:
        patch = tile_at(db, ensure_slide(db, item), **body.view.model_dump())
    visit = _cursor_visit(db, user)
    # Reloading a shared link reopens the cursor instead of recording another visit.
    if visit and visit.patch_id == patch.id:
        return _open(db, user, visit, background)
    return _record(db, user, patch, folder_id, background)


@router.get("/{patch_id}/tiles/{z}/{x}/{y}")
def patch_tile(
    patch_id: int,
    z: int,
    x: int,
    y: int,
    _user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Response:
    patch = db.get(Patch, patch_id)
    if not patch:
        raise HTTPException(404, "patch not found")
    data, media_type = tile(patch.girder_item_id, z, x, y)
    return Response(
        content=data, media_type=media_type, headers={"Cache-Control": "private, max-age=86400"}
    )


@router.post("/{patch_id}/prepare")
def prepare_view(
    patch_id: int,
    body: View,
    background: BackgroundTasks,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    require_patch(db, user.id, patch_id)
    patch = db.get(Patch, patch_id)
    slide, nm_per_px = patch_scale(db, patch)
    within = (body.left, body.top, body.width, body.height)
    _queue_ai(db, user, patch, background, slide, nm_per_px, within)
    return {"ok": True}


@router.get("/{patch_id}/slide-thumbnail")
def slide_thumbnail(
    patch_id: int,
    _user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Response:
    patch = db.get(Patch, patch_id)
    if not patch:
        raise HTTPException(404, "patch not found")
    return Response(
        content=thumbnail(patch.girder_item_id, 512),
        media_type="image/png",
        headers={"Cache-Control": "private, max-age=86400"},
    )


@router.patch("/{patch_id}/annotations")
def edit_annotations(
    patch_id: int,
    body: Changes,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    require_patch(db, user.id, patch_id)
    lock(db)
    saved = apply_changes(db, user.id, db.get(Patch, patch_id), body)
    db.commit()
    return {"ok": True, "times": saved}
