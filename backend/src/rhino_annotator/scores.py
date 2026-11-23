import time
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, insert, literal, select
from sqlalchemy.orm import Session

from rhino_annotator.annotations import lock, require_patch
from rhino_annotator.auth import current_user
from rhino_annotator.db import among, get_db
from rhino_annotator.models import Job, Patch, Project, Score, User
from rhino_annotator.scope import current_project, layer_id

router = APIRouter(prefix="/patches")

# A score as the editor sees it: 0-100, or "na" for not scorable.
Value = int | Literal["na"]


class ScoreIn(BaseModel):
    job_id: int
    value: int | Literal["na"] = Field(union_mode="left_to_right")


def as_value(score: int | None) -> Value:
    return "na" if score is None else score


def scores_for(db: Session, layer: int, item_id: str) -> dict[str, Value]:
    rows = db.execute(
        select(Score.job_id, Score.value).where(Score.user_id == layer, Score.item_id == item_id)
    )
    return {str(job_id): as_value(value) for job_id, value in rows}


def counts(db: Session, layer: int, item_ids: list[str] | None) -> dict[str, int]:
    query = select(Score.item_id, func.count()).where(Score.user_id == layer)
    if item_ids is not None:
        query = query.where(among(Score.item_id, item_ids))
    return dict(db.execute(query.group_by(Score.item_id)).all())


def total(db: Session, layer: int, item_ids: list[str] | None) -> int:
    query = select(func.count()).select_from(Score).where(Score.user_id == layer)
    if item_ids is not None:
        query = query.where(among(Score.item_id, item_ids))
    return db.scalar(query)


def copy_scores(db: Session, layer: int, source_id: int, ids: list[str] | None) -> int:
    # Like annotations: a score already in the shared layer is never overwritten.
    s = Score.__table__.c
    values = {c.name: literal(layer) if c.name == "user_id" else c for c in s if c.name != "id"}
    values["created_by"] = func.coalesce(s.created_by, source_id)
    values["edited_by"] = func.coalesce(s.edited_by, source_id)
    source = select(*values.values()).where(s.user_id == source_id)
    if ids is not None:
        source = source.where(among(s.item_id, ids))
    statement = insert(Score).prefix_with("OR IGNORE").from_select(list(values), source)
    return db.execute(statement).rowcount


def _layer(db: Session, user: User, project: Project, patch_id: int, shared: bool | None) -> int:
    require_patch(db, user.id, project.id, patch_id)
    lock(db)
    layer = layer_id(project, user)
    if shared is not None and shared != (layer != user.id):
        # Not 409, which the editor reads as having no project.
        raise HTTPException(412, "This project's sharing changed. Reload to continue.")
    return layer


@router.put("/{patch_id}/scores")
def set_score(
    patch_id: int,
    body: ScoreIn,
    shared: bool | None = None,
    user: User = Depends(current_user),
    project: Project = Depends(current_project),
    db: Session = Depends(get_db),
) -> dict:
    job = db.get(Job, body.job_id)
    if not job or job.mode != "score":
        raise HTTPException(404, "score class not found")
    value = None if body.value == "na" else body.value
    if value is not None and not 0 <= value <= 100:
        raise HTTPException(400, "A score is between 0 and 100.")
    layer = _layer(db, user, project, patch_id, shared)
    item_id = db.get(Patch, patch_id).girder_item_id
    key = (Score.user_id == layer, Score.item_id == item_id, Score.job_id == job.id)
    now = time.time()
    if row := db.scalar(select(Score).where(*key)):
        row.value, row.updated, row.edited_by = value, now, user.id
    else:
        db.add(
            Score(
                item_id=item_id,
                user_id=layer,
                job_id=job.id,
                value=value,
                created=now,
                updated=now,
                created_by=user.id,
                edited_by=user.id,
            )
        )
    db.commit()
    return {"scores": scores_for(db, layer, item_id)}


@router.delete("/{patch_id}/scores/{job_id}")
def clear_score(
    patch_id: int,
    job_id: int,
    shared: bool | None = None,
    user: User = Depends(current_user),
    project: Project = Depends(current_project),
    db: Session = Depends(get_db),
) -> dict:
    layer = _layer(db, user, project, patch_id, shared)
    item_id = db.get(Patch, patch_id).girder_item_id
    db.execute(
        delete(Score).where(
            Score.user_id == layer, Score.item_id == item_id, Score.job_id == job_id
        )
    )
    db.commit()
    return {"scores": scores_for(db, layer, item_id)}
