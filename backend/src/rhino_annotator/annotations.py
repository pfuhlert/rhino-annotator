import json
import time
from uuid import uuid4

from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import and_, delete, or_, select, text
from sqlalchemy.orm import Session

from rhino_annotator.models import Annotation, Job, Patch, PatchVisit


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


def require_patch(db: Session, user_id: int, project_id: int, patch_id: int) -> None:
    if not db.scalar(
        select(PatchVisit.id)
        .where(
            PatchVisit.patch_id == patch_id,
            PatchVisit.user_id == user_id,
            PatchVisit.project_id == project_id,
        )
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


def visible(db: Session, user_id: int, patch: Patch) -> list[Annotation]:
    right, bottom = patch.left + patch.width, patch.top + patch.height
    return db.scalars(
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
    ).all()


def element_json(a: Annotation, patch: Patch) -> dict:
    return {
        "id": a.element_id,
        "type": a.type,
        **shift(json.loads(a.geometry), -patch.left, -patch.top),
        "jobId": a.job_id,
    }


def times(rows: list[Annotation]) -> dict[str, list[float | None]]:
    return {a.element_id: [a.created, a.updated] for a in rows}


def apply_changes(
    db: Session, layer_id: int, actor_id: int, patch: Patch, changes: Changes
) -> dict[str, list[float | None]]:
    # Caller holds BEGIN IMMEDIATE: worker completion and manual edits share this transaction.
    for el in changes.upsert:
        if el.type not in {"point", "polygon"}:
            raise HTTPException(400, "invalid element type")
        if not db.get(Job, el.jobId):
            raise HTTPException(404, "job not found")
    # A repeated id in one save keeps its last version.
    upserts = {el.id: el for el in changes.upsert}
    removed = set(changes.delete) | set(upserts)
    mine = (Annotation.item_id == patch.girder_item_id, Annotation.user_id == layer_id)
    # Edits replace the row, so carry over when and by whom the annotation was first saved.
    created = {
        row.element_id: row
        for row in db.execute(
            select(Annotation.element_id, Annotation.created, Annotation.created_by).where(
                *mine, Annotation.element_id.in_(upserts)
            )
        )
    }
    db.execute(delete(Annotation).where(*mine, Annotation.element_id.in_(removed)))
    now = time.time()
    rows = [
        Annotation(
            **element_row(
                patch.girder_item_id,
                layer_id,
                el.jobId,
                shift(el.model_dump(exclude={"jobId"}), patch.left, patch.top),
            ),
            created=created[el.id].created if el.id in created else now,
            updated=now,
            created_by=created[el.id].created_by if el.id in created else actor_id,
            edited_by=actor_id,
        )
        for el in upserts.values()
    ]
    db.add_all(rows)
    return times(rows)


def lock(db: Session) -> None:
    db.execute(text("BEGIN IMMEDIATE"))
