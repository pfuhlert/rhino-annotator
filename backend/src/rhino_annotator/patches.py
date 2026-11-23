from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, NonNegativeInt, PositiveInt
from sqlalchemy import select
from sqlalchemy.orm import Session

from rhino_annotator.annotations import (
    Changes,
    apply_changes,
    element_json,
    lock,
    require_patch,
    times,
    visible,
)
from rhino_annotator.auth import current_user, project_stains, set_folder
from rhino_annotator.config import FULL_IMAGE_MAX, job_ai_model
from rhino_annotator.db import get_db
from rhino_annotator.embeddings import queue_image
from rhino_annotator.girder import image_kind, thumbnail, tile
from rhino_annotator.images import INDEXING, ordered_items
from rhino_annotator.models import Job, Patch, PatchVisit, Project, Slide, User
from rhino_annotator.projects import outside
from rhino_annotator.scope import browse, current_project, layer_id, visited_filter
from rhino_annotator.scores import scores_for
from rhino_annotator.slides import (
    ensure_slide,
    open_item,
    patch_scale,
    set_split,
    slide_view,
    step,
    tile_at,
)

router = APIRouter(prefix="/patches")


def _dump(
    db: Session,
    user: User,
    project: Project,
    patch: Patch,
    visit: PatchVisit,
    slide: Slide,
    nm_per_px: float | None,
) -> dict:
    layer = layer_id(project, user)
    rows = visible(db, layer, patch)
    return {
        "id": patch.id,
        "item_id": patch.girder_item_id,
        # Picks the label classes offered for this image.
        "kind": image_kind(patch.girder_item_id),
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
        "scores": scores_for(db, layer, patch.girder_item_id),
        "times": times(rows),
        "shared_layer": layer != user.id,
        "slide": slide_view(db, visited_filter(project, user), patch),
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


def _open(
    db: Session, user: User, project: Project, visit: PatchVisit, background: BackgroundTasks
) -> dict:
    user.current_visit_id = visit.id
    patch = db.get(Patch, visit.patch_id)
    assert patch
    db.commit()
    slide, nm_per_px = patch_scale(db, patch)
    result = _dump(db, user, project, patch, visit, slide, nm_per_px)
    _queue_ai(db, user, patch, background, slide, nm_per_px)
    return result


def _items(db: Session, folders: list[str]) -> list[dict]:
    items = ordered_items(db, folders)
    if items is None:
        # Not 409, which the editor reads as having no project.
        raise HTTPException(503, INDEXING)
    return items


def _step(
    db: Session,
    user: User,
    project: Project,
    direction: Literal[1, -1],
    background: BackgroundTasks,
) -> dict:
    key, folders = browse(db, user, project)
    visit = _cursor_visit(db, user, project, key) or _last_in_folder(db, user, project, key)
    current = db.get(Patch, visit.patch_id) if visit else None
    stains = project_stains(db, user, project.id)
    try:
        patch = step(db, user, _items(db, folders), current, direction, stains)
    except RuntimeError as e:
        raise HTTPException(400, str(e)) from e
    return _record(db, user, project, patch, key, background)


def _record(
    db: Session,
    user: User,
    project: Project,
    patch: Patch,
    key: str,
    background: BackgroundTasks,
) -> dict:
    visit = PatchVisit(user_id=user.id, patch_id=patch.id, folder_id=key, project_id=project.id)
    db.add(visit)
    db.flush()
    return _open(db, user, project, visit, background)


# History is kept per project and, within it, per browsed folder.
def _cursor_visit(db: Session, user: User, project: Project, key: str) -> PatchVisit | None:
    visit = db.get(PatchVisit, user.current_visit_id) if user.current_visit_id else None
    if visit and visit.folder_id == key and visit.project_id == project.id:
        return visit
    return None


def _last_in_folder(db: Session, user: User, project: Project, key: str) -> PatchVisit | None:
    return db.scalar(
        select(PatchVisit)
        .where(
            PatchVisit.user_id == user.id,
            PatchVisit.project_id == project.id,
            PatchVisit.folder_id == key,
        )
        .order_by(PatchVisit.id.desc())
        .limit(1)
    )


@router.get("/current")
def current_patch(
    background: BackgroundTasks,
    user: User = Depends(current_user),
    project: Project = Depends(current_project),
    db: Session = Depends(get_db),
) -> dict:
    key, _folders = browse(db, user, project)
    visit = _cursor_visit(db, user, project, key) or _last_in_folder(db, user, project, key)
    # An image whose folder was since removed from the project is not reopened.
    if visit and not outside(db, project, db.get(Patch, visit.patch_id).girder_item_id):
        return _open(db, user, project, visit, background)
    return _step(db, user, project, 1, background)


@router.get("/next")
def next_patch(
    background: BackgroundTasks,
    user: User = Depends(current_user),
    project: Project = Depends(current_project),
    db: Session = Depends(get_db),
) -> dict:
    return _step(db, user, project, 1, background)


@router.get("/prev")
def prev_patch(
    background: BackgroundTasks,
    user: User = Depends(current_user),
    project: Project = Depends(current_project),
    db: Session = Depends(get_db),
) -> dict:
    return _step(db, user, project, -1, background)


class View(BaseModel):
    left: NonNegativeInt
    top: NonNegativeInt
    width: PositiveInt
    height: PositiveInt


class OpenImage(BaseModel):
    item_id: str
    # A shared link names its dataset and the visible slide rectangle; a layout switch names only
    # the rectangle, to keep the user's place.
    folder_id: str | None = None
    view: View | None = None
    # Splits a histology slide by tissue, or shows it whole, for this user from now on.
    split: bool | None = None


@router.post("/open")
def open_image(
    body: OpenImage,
    background: BackgroundTasks,
    user: User = Depends(current_user),
    project: Project = Depends(current_project),
    db: Session = Depends(get_db),
) -> dict:
    if body.folder_id:
        set_folder(db, user, project.id, body.folder_id)
    key, folders = browse(db, user, project)
    item = next((it for it in _items(db, folders) if it["_id"] == body.item_id), None)
    if not item:
        raise HTTPException(404, "image not in this dataset")
    if body.split is not None:
        try:
            set_split(db, user, item, body.split)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
    if body.view is None:
        patch = open_item(db, user, visited_filter(project, user), item)
    else:
        # A shared link must show the shared area; a layout switch stays in the chosen layout.
        shared = body.folder_id is not None and body.split is None
        slide = ensure_slide(db, item)
        patch = tile_at(db, user, slide, **body.view.model_dump(), show_all=shared)
    visit = _cursor_visit(db, user, project, key)
    # Reloading a shared link reopens the cursor instead of recording another visit.
    if visit and visit.patch_id == patch.id:
        return _open(db, user, project, visit, background)
    return _record(db, user, project, patch, key, background)


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
    project: Project = Depends(current_project),
    db: Session = Depends(get_db),
) -> dict:
    require_patch(db, user.id, project.id, patch_id)
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
    # The layer the editor loaded. Element ids repeat across layers, so a tab opened before the
    # project's sharing changed must not write its marks over the other layer's.
    shared: bool | None = None,
    user: User = Depends(current_user),
    project: Project = Depends(current_project),
    db: Session = Depends(get_db),
) -> dict:
    require_patch(db, user.id, project.id, patch_id)
    lock(db)
    layer = layer_id(project, user)
    if shared is not None and shared != (layer != user.id):
        # Not 409, which the editor reads as having no project.
        raise HTTPException(412, "This project's sharing changed. Reload to continue.")
    saved = apply_changes(db, layer, user.id, db.get(Patch, patch_id), body)
    db.commit()
    return {"ok": True, "times": saved}
