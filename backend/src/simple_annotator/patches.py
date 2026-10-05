from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, NonNegativeInt, PositiveInt
from sqlalchemy import select
from sqlalchemy.orm import Session

from simple_annotator.annotations import (
    Changes,
    apply_changes,
    elements,
    lock,
    require_patch,
    row_elements,
)
from simple_annotator.auth import current_user
from simple_annotator.config import FULL_IMAGE_MAX, job_ai_model
from simple_annotator.db import get_db
from simple_annotator.embeddings import queue_image
from simple_annotator.girder import PLACEHOLDER_FOLDER, thumbnail, tile
from simple_annotator.models import Annotation, Job, Patch, PatchVisit, Slide, User
from simple_annotator.slides import next_tile, patch_scale, slide_view

router = APIRouter(prefix="/patches")


def _dump(
    db: Session, user: User, patch: Patch, visit: PatchVisit, slide: Slide, nm_per_px: float | None
) -> dict:
    prev = db.scalar(
        select(PatchVisit.id)
        .where(
            PatchVisit.user_id == user.id,
            PatchVisit.folder_id == visit.folder_id,
            PatchVisit.id < visit.id,
        )
        .limit(1)
    )
    return {
        "id": patch.id,
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
        "has_prev": prev is not None,
        "elements": elements(db, user.id, patch.id),
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


def _new_visit(db: Session, user: User, background: BackgroundTasks) -> dict:
    folder_id = _folder_id(user)
    current = _cursor_visit(db, user)
    current_item = db.get(Patch, current.patch_id).girder_item_id if current else None
    try:
        patch = next_tile(db, user, folder_id, current_item)
    except RuntimeError as e:
        raise HTTPException(400, str(e)) from e
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
    return _open(db, user, visit, background) if visit else _new_visit(db, user, background)


@router.get("/next")
def next_patch(
    background: BackgroundTasks, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    cur = _cursor_visit(db, user)
    if cur:
        later = db.scalar(
            select(PatchVisit)
            .where(
                PatchVisit.user_id == user.id,
                PatchVisit.folder_id == cur.folder_id,
                PatchVisit.id > cur.id,
            )
            .order_by(PatchVisit.id)
            .limit(1)
        )
        if later:
            return _open(db, user, later, background)
    return _new_visit(db, user, background)


@router.get("/prev")
def prev_patch(
    background: BackgroundTasks, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    cur = _cursor_visit(db, user)
    if cur:
        earlier = db.scalar(
            select(PatchVisit)
            .where(
                PatchVisit.user_id == user.id,
                PatchVisit.folder_id == cur.folder_id,
                PatchVisit.id < cur.id,
            )
            .order_by(PatchVisit.id.desc())
            .limit(1)
        )
        if earlier:
            return _open(db, user, earlier, background)
    raise HTTPException(404, "no previous patch")


@router.get("/visits")
def visits(user: User = Depends(current_user), db: Session = Depends(get_db)) -> list[dict]:
    rows = db.scalars(
        select(PatchVisit)
        .where(PatchVisit.user_id == user.id, PatchVisit.folder_id == _folder_id(user))
        .order_by(PatchVisit.id.desc())
    ).all()
    counts: dict[int, int] = {}
    for ann in db.scalars(
        select(Annotation).where(
            Annotation.user_id == user.id, Annotation.patch_id.in_([v.patch_id for v in rows])
        )
    ):
        n = sum(el.get("type") == "polygon" for el in row_elements(ann))
        counts[ann.patch_id] = counts.get(ann.patch_id, 0) + n
    return [
        {"id": v.id, "patch_id": v.patch_id, "n_annotations": counts.get(v.patch_id, 0)}
        for v in rows
    ]


@router.get("/visits/{visit_id}")
def open_visit(
    visit_id: int,
    background: BackgroundTasks,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    visit = db.get(PatchVisit, visit_id)
    if not visit or visit.user_id != user.id or visit.folder_id != _folder_id(user):
        raise HTTPException(404, "visit not found")
    return _open(db, user, visit, background)


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


class View(BaseModel):
    left: NonNegativeInt
    top: NonNegativeInt
    width: PositiveInt
    height: PositiveInt


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
    apply_changes(db, user.id, patch_id, body)
    db.commit()
    return {"ok": True}
