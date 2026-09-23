import json
from uuid import uuid4

from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from simple_annotator.models import Annotation, Job, PatchVisit


class Element(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex, min_length=1, max_length=100)
    type: str
    points: list[list[float]]
    holes: list[list[list[float]]] = []


class Edit(Element):
    jobId: int


class Changes(BaseModel):
    upsert: list[Edit] = Field(default_factory=list, max_length=10000)
    delete: list[str] = Field(default_factory=list, max_length=10000)


def require_patch(db: Session, user_id: int, patch_id: int) -> None:
    if not db.scalar(
        select(PatchVisit.id)
        .where(PatchVisit.patch_id == patch_id, PatchVisit.user_id == user_id)
        .limit(1)
    ):
        raise HTTPException(404, "patch not found")


def ai_element_id(task_id: str) -> str:
    return f"ai-{task_id}"


def _row_elements(row: Annotation) -> list[dict]:
    marks = json.loads(row.elements)
    for i, el in enumerate(marks):
        el.setdefault("id", f"legacy-{row.id}-{i}")
    return marks


def elements(db: Session, user_id: int, patch_id: int) -> list[dict]:
    return [
        {**el, "jobId": row.job_id}
        for row in db.scalars(
            select(Annotation).where(Annotation.patch_id == patch_id, Annotation.user_id == user_id)
        )
        for el in _row_elements(row)
    ]


def apply_changes(db: Session, user_id: int, patch_id: int, changes: Changes) -> None:
    # Caller holds BEGIN IMMEDIATE: worker completion and manual edits share this transaction.
    rows = {
        row.job_id: row
        for row in db.scalars(
            select(Annotation).where(Annotation.patch_id == patch_id, Annotation.user_id == user_id)
        )
    }
    by_job = {job_id: {el["id"]: el for el in _row_elements(row)} for job_id, row in rows.items()}
    removed = set(changes.delete) | {el.id for el in changes.upsert}
    touched = set()
    for job_id, marks in by_job.items():
        if removed.intersection(marks):
            touched.add(job_id)
            for key in removed:
                marks.pop(key, None)
    for el in changes.upsert:
        if el.type not in {"point", "polygon"}:
            raise HTTPException(400, "invalid element type")
        if not db.get(Job, el.jobId):
            raise HTTPException(404, "job not found")
        by_job.setdefault(el.jobId, {})[el.id] = el.model_dump(
            exclude={"jobId"}, exclude_defaults=True
        )
        touched.add(el.jobId)
    for job_id in touched:
        marks = list(by_job[job_id].values())
        row = rows.get(job_id)
        if not marks:
            if row:
                db.delete(row)
        elif row:
            row.elements = json.dumps(marks)
        else:
            db.add(
                Annotation(
                    patch_id=patch_id, user_id=user_id, job_id=job_id, elements=json.dumps(marks)
                )
            )


def lock(db: Session) -> None:
    db.execute(text("BEGIN IMMEDIATE"))
