import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from simple_annotator.auth import current_user
from simple_annotator.db import get_db
from simple_annotator.girder import fetch_image, pick_region
from simple_annotator.models import Annotation, Job, Patch, PatchVisit, User, VisitCursor

router = APIRouter(prefix="/patches")


class Element(BaseModel):
    type: str
    points: list[list[float]]


class AnnotationIn(BaseModel):
    job_id: int
    elements: list[Element] = []


def _set_job(db: Session, user: User, job_id: int) -> None:
    if not db.get(Job, job_id):
        raise HTTPException(404, "job not found")
    user.last_job_id = job_id


def _elements(db: Session, user: User, patch_id: int) -> list[dict]:
    out: list[dict] = []
    for row in db.scalars(
        select(Annotation).where(Annotation.patch_id == patch_id, Annotation.user_id == user.id)
    ):
        for el in json.loads(row.elements):
            out.append({**el, "jobId": row.job_id})
    return out


def _dump(db: Session, user: User, patch: Patch, visit_id: int) -> dict:
    prev = db.scalar(
        select(PatchVisit.id)
        .where(PatchVisit.user_id == user.id, PatchVisit.id < visit_id)
        .limit(1)
    )
    return {
        "id": patch.id,
        "job_id": user.last_job_id,
        "girder_item_id": patch.girder_item_id,
        "left": patch.left,
        "top": patch.top,
        "width": patch.width,
        "height": patch.height,
        "image_url": f"/patches/{patch.id}/image",
        "has_prev": prev is not None,
        "elements": _elements(db, user, patch.id),
    }


def _open(db: Session, user: User, visit: PatchVisit) -> dict:
    cur = db.get(VisitCursor, user.id)
    if cur:
        cur.visit_id = visit.id
    else:
        db.add(VisitCursor(user_id=user.id, visit_id=visit.id))
    db.commit()
    patch = db.get(Patch, visit.patch_id)
    if not patch:
        raise HTTPException(404, "patch not found")
    return _dump(db, user, patch, visit.id)


def _new_visit(db: Session, user: User) -> dict:
    patch = Patch(**pick_region())
    db.add(patch)
    db.flush()
    visit = PatchVisit(user_id=user.id, patch_id=patch.id)
    db.add(visit)
    db.flush()
    return _open(db, user, visit)


@router.get("/current")
def current_patch(user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    cur = db.get(VisitCursor, user.id)
    if not cur:
        return _new_visit(db, user)
    visit = db.get(PatchVisit, cur.visit_id)
    if not visit:
        return _new_visit(db, user)
    return _open(db, user, visit)


@router.get("/next")
def next_patch(user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    cur = db.get(VisitCursor, user.id)
    if cur:
        later = db.scalar(
            select(PatchVisit)
            .where(PatchVisit.user_id == user.id, PatchVisit.id > cur.visit_id)
            .order_by(PatchVisit.id)
            .limit(1)
        )
        if later:
            return _open(db, user, later)
    return _new_visit(db, user)


@router.get("/prev")
def prev_patch(user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    cur = db.get(VisitCursor, user.id)
    if not cur:
        raise HTTPException(404, "no previous patch")
    earlier = db.scalar(
        select(PatchVisit)
        .where(PatchVisit.user_id == user.id, PatchVisit.id < cur.visit_id)
        .order_by(PatchVisit.id.desc())
        .limit(1)
    )
    if not earlier:
        raise HTTPException(404, "no previous patch")
    return _open(db, user, earlier)


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
    for el in body.elements:
        if el.type not in {"point", "polygon"}:
            raise HTTPException(400, "invalid element type")
    _set_job(db, user, body.job_id)
    row = db.scalar(
        select(Annotation).where(
            Annotation.patch_id == patch.id,
            Annotation.user_id == user.id,
            Annotation.job_id == body.job_id,
        )
    )
    payload = json.dumps([el.model_dump() for el in body.elements])
    if row and not body.elements:
        db.delete(row)
        db.commit()
        return {"id": None, "last_job_id": user.last_job_id}
    if row:
        row.elements = payload
    elif body.elements:
        row = Annotation(patch_id=patch.id, user_id=user.id, job_id=body.job_id, elements=payload)
        db.add(row)
    else:
        db.commit()
        return {"id": None, "last_job_id": user.last_job_id}
    db.commit()
    db.refresh(row)
    return {"id": row.id, "last_job_id": user.last_job_id}
