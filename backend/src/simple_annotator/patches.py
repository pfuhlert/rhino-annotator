import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from simple_annotator.auth import current_user, require_job
from simple_annotator.db import get_db
from simple_annotator.girder import PLACEHOLDER_FOLDER, fetch_image, pick_region
from simple_annotator.models import Annotation, Patch, PatchVisit, User

router = APIRouter(prefix="/patches")


class Element(BaseModel):
    type: str
    points: list[list[float]]
    holes: list[list[list[float]]] = []


class AnnotationIn(BaseModel):
    job_id: int
    elements: list[Element] = []


def _elements(db: Session, user: User, patch_id: int) -> list[dict]:
    out: list[dict] = []
    for row in db.scalars(
        select(Annotation).where(Annotation.patch_id == patch_id, Annotation.user_id == user.id)
    ):
        for el in json.loads(row.elements):
            out.append({**el, "jobId": row.job_id})
    return out


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
        "has_prev": prev is not None,
        "elements": _elements(db, user, patch.id),
    }


def _open(db: Session, user: User, visit: PatchVisit) -> dict:
    user.current_visit_id = visit.id
    db.commit()
    patch = db.get(Patch, visit.patch_id)
    assert patch
    return _dump(db, user, patch, visit)


def _folder_id(user: User) -> str:
    if not user.last_folder_id:
        user.last_folder_id = PLACEHOLDER_FOLDER
    return user.last_folder_id


def _new_visit(db: Session, user: User) -> dict:
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
    return _open(db, user, visit)


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
def current_patch(user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    visit = _cursor_visit(db, user) or _last_in_folder(db, user)
    return _open(db, user, visit) if visit else _new_visit(db, user)


@router.get("/next")
def next_patch(user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
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
            return _open(db, user, later)
    return _new_visit(db, user)


@router.get("/prev")
def prev_patch(user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
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
            return _open(db, user, earlier)
    raise HTTPException(404, "no previous patch")


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


@router.post("/{patch_id}/annotations")
def save_annotations(
    patch_id: int,
    body: AnnotationIn,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    patch = db.get(Patch, patch_id)
    if not patch:
        raise HTTPException(404, "patch not found")
    if any(el.type not in {"point", "polygon"} for el in body.elements):
        raise HTTPException(400, "invalid element type")
    require_job(db, body.job_id)
    row = db.scalar(
        select(Annotation).where(
            Annotation.patch_id == patch.id,
            Annotation.user_id == user.id,
            Annotation.job_id == body.job_id,
        )
    )
    if not body.elements:
        if row:
            db.delete(row)
        db.commit()
        return {"id": None, "last_job_id": user.last_job_id}
    payload = json.dumps([el.model_dump(exclude_defaults=True) for el in body.elements])
    if row:
        row.elements = payload
    else:
        row = Annotation(patch_id=patch.id, user_id=user.id, job_id=body.job_id, elements=payload)
        db.add(row)
    db.commit()
    db.refresh(row)
    return {"id": row.id, "last_job_id": user.last_job_id}
