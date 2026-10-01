from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import Response
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
from simple_annotator.config import DEFAULT_AI_MODEL, job_ai_model
from simple_annotator.db import get_db
from simple_annotator.embeddings import queue_image
from simple_annotator.girder import PLACEHOLDER_FOLDER, fetch_image, image_nm_per_px, pick_region
from simple_annotator.models import Annotation, Job, Patch, PatchVisit, User

router = APIRouter(prefix="/patches")


def _dump(db: Session, user: User, patch: Patch, visit: PatchVisit) -> dict:
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
        "image_url": f"/patches/{patch.id}/image",
        "nm_per_px": image_nm_per_px(patch.girder_item_id),
        "has_prev": prev is not None,
        "elements": elements(db, user.id, patch.id),
    }


def _open(db: Session, user: User, visit: PatchVisit, background: BackgroundTasks) -> dict:
    user.current_visit_id = visit.id
    patch = db.get(Patch, visit.patch_id)
    assert patch
    db.commit()
    result = _dump(db, user, patch, visit)
    job = db.get(Job, user.last_job_id) if user.last_job_id else None
    models = list(dict.fromkeys([DEFAULT_AI_MODEL, job_ai_model(job and job.name)]))
    background.add_task(queue_image, patch.id, result["nm_per_px"], models)
    return result


def _folder_id(user: User) -> str:
    if not user.last_folder_id:
        user.last_folder_id = PLACEHOLDER_FOLDER
    return user.last_folder_id


def _new_visit(db: Session, user: User, background: BackgroundTasks) -> dict:
    folder_id = _folder_id(user)
    try:
        patch = Patch(**pick_region(folder_id))
    except RuntimeError as e:
        raise HTTPException(400, str(e)) from e
    db.add(patch)
    db.flush()
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


@router.get("/{patch_id}/image")
def patch_image(
    patch_id: int,
    _user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Response:
    patch = db.get(Patch, patch_id)
    if not patch:
        raise HTTPException(404, "patch not found")
    data = fetch_image(patch.girder_item_id, patch.left, patch.top, patch.width, patch.height)
    return Response(content=data, media_type="image/png")


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
