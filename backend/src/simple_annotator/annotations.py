import json
from uuid import uuid4

from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import and_, delete, or_, select, text
from sqlalchemy.orm import Session

from simple_annotator.models import Annotation, Job, Patch, PatchVisit


class Element(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex, min_length=1, max_length=100)
    type: str
    points: list[tuple[float, float]] = Field(min_length=1)
    holes: list[list[tuple[float, float]]] = []


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


def shift(el: dict, dx: float, dy: float) -> dict:
    def move(ring: list[list[float]]) -> list[list[float]]:
        return [[x + dx, y + dy] for x, y in ring]

    moved = {**el, "points": move(el["points"])}
    if el.get("holes"):
        moved["holes"] = [move(ring) for ring in el["holes"]]
    return moved


def element_row(item_id: str, user_id: int, job_id: int, el: dict) -> dict:
    xs = [x for x, _ in el["points"]]
    ys = [y for _, y in el["points"]]
    geometry = {k: el[k] for k in ("points", "holes") if el.get(k)}
    return {
        "element_id": el["id"],
        "item_id": item_id,
        "user_id": user_id,
        "job_id": job_id,
        "type": el["type"],
        "geometry": json.dumps(geometry),
        "x0": min(xs),
        "y0": min(ys),
        "x1": max(xs),
        "y1": max(ys),
    }


def elements(db: Session, user_id: int, patch: Patch) -> list[dict]:
    right, bottom = patch.left + patch.width, patch.top + patch.height
    rows = db.scalars(
        select(Annotation)
        .where(
            Annotation.item_id == patch.girder_item_id,
            Annotation.user_id == user_id,
            Annotation.x0 < right,
            Annotation.y0 < bottom,
            # A point belongs to the pixel it sits in; a polygon shows if its box overlaps.
            or_(
                and_(
                    Annotation.type == "point",
                    Annotation.x1 >= patch.left,
                    Annotation.y1 >= patch.top,
                ),
                and_(Annotation.x1 > patch.left, Annotation.y1 > patch.top),
            ),
        )
        .order_by(Annotation.id)
    )
    return [
        {
            "id": a.element_id,
            "type": a.type,
            **shift(json.loads(a.geometry), -patch.left, -patch.top),
            "jobId": a.job_id,
        }
        for a in rows
    ]


def apply_changes(db: Session, user_id: int, patch: Patch, changes: Changes) -> None:
    # Caller holds BEGIN IMMEDIATE: worker completion and manual edits share this transaction.
    for el in changes.upsert:
        if el.type not in {"point", "polygon"}:
            raise HTTPException(400, "invalid element type")
        if not db.get(Job, el.jobId):
            raise HTTPException(404, "job not found")
    removed = set(changes.delete) | {el.id for el in changes.upsert}
    db.execute(
        delete(Annotation).where(
            Annotation.item_id == patch.girder_item_id,
            Annotation.user_id == user_id,
            Annotation.element_id.in_(removed),
        )
    )
    db.add_all(
        Annotation(
            **element_row(
                patch.girder_item_id,
                user_id,
                el.jobId,
                shift(el.model_dump(exclude={"jobId"}), patch.left, patch.top),
            )
        )
        for el in changes.upsert
    )


def lock(db: Session) -> None:
    db.execute(text("BEGIN IMMEDIATE"))
