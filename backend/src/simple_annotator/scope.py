import httpx
from fastapi import Depends, HTTPException
from sqlalchemy import ColumnElement, literal_column, select
from sqlalchemy.orm import Session

from simple_annotator.auth import current_user
from simple_annotator.db import get_db
from simple_annotator.girder import PLACEHOLDER_FOLDER, ancestors
from simple_annotator.models import PatchVisit, Project, ProjectFolder, ProjectMember, User


def can_open(db: Session, project: Project, user: User) -> bool:
    if project.owner_id == user.id or project.visibility == "everyone":
        return True
    return project.visibility == "people" and bool(db.get(ProjectMember, (project.id, user.id)))


def current_project(
    project: int | None = None,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> Project:
    # The editor names its project in each request, so opening another in a second tab cannot
    # redirect this tab's saves; without one, the project last opened.
    project_id = project or user.last_project_id
    found = db.get(Project, project_id) if project_id else None
    if not found or not can_open(db, found, user):
        raise HTTPException(409, "Choose a project first.")
    return found


def layer_id(project: Project, user: User) -> int:
    # Every annotation read and write goes to the shared layer while the project is shared.
    if project.visibility != "private" and project.layer_user_id:
        return project.layer_user_id
    return user.id


# Visits follow the annotation layer: a shared project counts every member's visits in it.
def visited_filter(project: Project, user: User) -> ColumnElement[bool]:
    if layer_id(project, user) == user.id:
        return PatchVisit.user_id == user.id
    return PatchVisit.project_id == project.id


def roots(db: Session, project_id: int) -> list[str]:
    return list(
        db.scalars(
            select(ProjectFolder.folder_id)
            .where(ProjectFolder.project_id == project_id)
            .order_by(literal_column("rowid"))
        )
    )


# Stands for all of a project's folders where a single folder id would go.
def union_key(project: Project) -> str:
    return f"project-{project.id}"


def is_union_key(folder_id: str | None) -> bool:
    return bool(folder_id) and folder_id.startswith("project-")


def inside(folder_id: str, folder_ids: list[str]) -> bool:
    try:
        return folder_id in folder_ids or any(a in folder_ids for a in ancestors(folder_id))
    except httpx.HTTPError:
        return False


# The folder key the user browses in this project and the folders it covers.
def browse(db: Session, user: User, project: Project) -> tuple[str, list[str]]:
    folders = roots(db, project.id)
    if not folders:
        if not user.last_folder_id or is_union_key(user.last_folder_id):
            user.last_folder_id = PLACEHOLDER_FOLDER
        return user.last_folder_id, [user.last_folder_id]
    chosen = user.last_folder_id
    if chosen and not is_union_key(chosen) and inside(chosen, folders):
        return chosen, [chosen]
    return union_key(project), folders
