import json
import math
import time
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, StrictInt
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from simple_annotator.annotations import (
    Changes,
    ai_element_id,
    apply_changes,
    element_json,
    lock,
    require_patch,
    times,
    visible,
)
from simple_annotator.auth import current_user
from simple_annotator.config import job_ai_model
from simple_annotator.db import get_db
from simple_annotator.embeddings import prompt_regions
from simple_annotator.models import AiTask, AiWorker, Job, Patch, Project, User
from simple_annotator.scope import current_project, layer_id
from simple_annotator.slides import patch_scale

router = APIRouter(prefix="/patches")
# Tasks from before projects have no layer and wrote to their user's own.
_task_layer = func.coalesce(AiTask.layer_id, AiTask.user_id)


class Prompt(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: UUID
    job_id: int


class PointPrompt(Prompt):
    x: float
    y: float


class BoxPrompt(Prompt):
    box: tuple[StrictInt, StrictInt, StrictInt, StrictInt]


def task_json(task: AiTask) -> dict:
    prompt = json.loads(task.input)
    return {
        "id": task.id,
        "patch_id": task.patch_id,
        "job_id": task.job_id,
        **{key: prompt[key] for key in ("x", "y", "box") if key in prompt},
        "status": task.status,
        "error": task.error,
        "elapsed_ms": task.elapsed_ms,
    }


@router.get("/ai")
def status(
    patch_id: int,
    after: float = 0,
    user: User = Depends(current_user),
    project: Project = Depends(current_project),
    db: Session = Depends(get_db),
) -> dict:
    require_patch(db, user.id, project.id, patch_id)
    patch = db.get(Patch, patch_id)
    worker = db.get(AiWorker, 1)
    available = bool(worker and time.time() - worker.updated < 15)
    layer = layer_id(project, user)
    tasks = db.scalars(
        select(AiTask)
        .where(
            AiTask.user_id == user.id,
            _task_layer == layer,
            (AiTask.status.in_(["queued", "running", "failed"]))
            | (
                # Results land on the image, so overlapping patches show them too.
                AiTask.patch_id.in_(
                    select(Patch.id).where(Patch.girder_item_id == patch.girder_item_id)
                )
                & (AiTask.status == "done")
                & (AiTask.finished > after)
            ),
        )
        .order_by(AiTask.created)
    ).all()
    done = {ai_element_id(t.id) for t in tasks if t.status == "done"}
    rows = [a for a in visible(db, layer, patch) if a.element_id in done] if done else []
    return {
        "cursor": max((t.finished or 0 for t in tasks), default=after),
        "worker": worker.status if available else "offline",
        "tasks": [task_json(t) for t in tasks if t.status != "done"],
        "elements": [element_json(a, patch) for a in rows],
        "times": times(rows),
    }


@router.post("/{patch_id}/ai", status_code=202)
def enqueue(
    patch_id: int,
    body: PointPrompt | BoxPrompt,
    user: User = Depends(current_user),
    project: Project = Depends(current_project),
    db: Session = Depends(get_db),
) -> dict:
    require_patch(db, user.id, project.id, patch_id)
    task_id = str(body.id)
    patch = db.get(Patch, patch_id)
    prompt = body.model_dump(mode="json", exclude={"id", "job_id"})
    slide, nm_per_px = patch_scale(db, patch)
    lock(db)
    old = db.get(AiTask, task_id)
    if old:
        saved = task_json(old)
        if (
            old.user_id != user.id
            or old.patch_id != patch_id
            or old.job_id != body.job_id
            or any(saved.get(key) != prompt.get(key) for key in ("x", "y", "box"))
        ):
            raise HTTPException(409, "request ID already used")
        return saved
    job = db.get(Job, body.job_id)
    if not job:
        raise HTTPException(400, "unknown job")
    request = {
        "model": job_ai_model(job.name, slide.histo).name,
        **prompt,
        "item_id": patch.girder_item_id,
        "left": patch.left,
        "top": patch.top,
        "width": patch.width,
        "height": patch.height,
        "nm_per_px": nm_per_px,
        "histo": slide.histo,
    }
    if isinstance(body, BoxPrompt):
        x0, y0, x1, y1 = body.box
        if not (0 <= x0 < x1 <= patch.width and 0 <= y0 < y1 <= patch.height):
            raise HTTPException(400, "box must be inside the image")
        if x1 - x0 < 2 or y1 - y0 < 2:
            raise HTTPException(400, "box must be at least 2 pixels wide and high")
        try:
            prompt_regions(request)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
    else:
        if not (
            math.isfinite(body.x)
            and math.isfinite(body.y)
            and 0 <= body.x < patch.width
            and 0 <= body.y < patch.height
        ):
            raise HTTPException(400, "click must be inside the image")
    worker = db.get(AiWorker, 1)
    if not worker or time.time() - worker.updated >= 15:
        raise HTTPException(503, "AI worker is offline")
    count = db.scalar(
        select(func.count())
        .select_from(AiTask)
        .where(AiTask.user_id == user.id, AiTask.status.in_(["queued", "running"]))
    )
    if count >= 32:
        raise HTTPException(429, "AI queue is full; please let a few annotations finish")
    task = AiTask(
        id=task_id,
        user_id=user.id,
        patch_id=patch_id,
        job_id=body.job_id,
        layer_id=layer_id(project, user),
        status="queued",
        created=time.time(),
        input=json.dumps(request),
    )
    db.add(task)
    db.commit()
    return task_json(task)


@router.delete("/ai/{task_id}")
def cancel(
    task_id: str,
    user: User = Depends(current_user),
    project: Project = Depends(current_project),
    db: Session = Depends(get_db),
) -> dict:
    lock(db)
    task = db.get(AiTask, task_id)
    # Only from the layer it writes to, so a member removed from a project cannot edit its layer.
    layer = layer_id(project, user)
    if not task or task.user_id != user.id or (task.layer_id or task.user_id) != layer:
        raise HTTPException(404, "AI task not found")
    # Completion may win the race with Cancel; remove its annotation in the same transaction.
    if task.status == "done":
        patch = db.get(Patch, task.patch_id)
        apply_changes(db, layer, user.id, patch, Changes(delete=[ai_element_id(task.id)]))
    task.status = "cancelled"
    db.commit()
    return {"ok": True}
