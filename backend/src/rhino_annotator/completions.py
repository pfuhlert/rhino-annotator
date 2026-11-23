import time

from fastapi import APIRouter, Depends
from sqlalchemy import delete, func, insert, literal, select
from sqlalchemy.orm import Session

from rhino_annotator.auth import current_user
from rhino_annotator.db import among, get_db
from rhino_annotator.models import Completion, Patch, Project, User
from rhino_annotator.scope import current_project
from rhino_annotator.scores import edit_layer

router = APIRouter(prefix="/patches")


def is_complete(db: Session, layer: int, item_id: str) -> bool:
    query = select(Completion.id).where(Completion.user_id == layer, Completion.item_id == item_id)
    return db.scalar(query) is not None


def completed(db: Session, layer: int, item_ids: list[str] | None) -> set[str]:
    query = select(Completion.item_id).where(Completion.user_id == layer)
    if item_ids is not None:
        query = query.where(among(Completion.item_id, item_ids))
    return set(db.scalars(query))


def copy_completions(db: Session, layer: int, source_id: int, ids: list[str] | None) -> int:
    c = Completion.__table__.c
    values = {
        "item_id": c.item_id,
        "user_id": literal(layer),
        "created": c.created,
        "created_by": func.coalesce(c.created_by, source_id),
    }
    source = select(*values.values()).where(c.user_id == source_id)
    if ids is not None:
        source = source.where(among(c.item_id, ids))
    statement = insert(Completion).prefix_with("OR IGNORE").from_select(list(values), source)
    return db.execute(statement).rowcount


@router.put("/{patch_id}/complete")
def set_complete(
    patch_id: int,
    complete: bool,
    shared: bool | None = None,
    user: User = Depends(current_user),
    project: Project = Depends(current_project),
    db: Session = Depends(get_db),
) -> dict:
    layer = edit_layer(db, user, project, patch_id, shared)
    item_id = db.get(Patch, patch_id).girder_item_id
    if not complete:
        db.execute(
            delete(Completion).where(Completion.user_id == layer, Completion.item_id == item_id)
        )
    elif not is_complete(db, layer, item_id):
        db.add(Completion(item_id=item_id, user_id=layer, created=time.time(), created_by=user.id))
    db.commit()
    return {"complete": is_complete(db, layer, item_id)}
