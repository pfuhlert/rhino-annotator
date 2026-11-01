import secrets
import time
from typing import Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, insert, literal, literal_column, select, update
from sqlalchemy.orm import Session

from simple_annotator.auth import current_user
from simple_annotator.db import ELMI_JOBS, SEED_JOBS, among, get_db, preset_ids
from simple_annotator.girder import (
    ancestors,
    folder_kind,
    folder_path,
    folder_row,
    item_folder,
    list_folders,
)
from simple_annotator.images import listed, listing_error
from simple_annotator.models import (
    LOCKED_PASSWORD,
    Annotation,
    Job,
    PatchVisit,
    Project,
    ProjectFolder,
    ProjectJob,
    ProjectMember,
    ProjectOpen,
    User,
)
from simple_annotator.scope import can_open, current_project, inside, layer_id, roots, union_key

router = APIRouter()

PRESETS = {"histo": SEED_JOBS, "elmi": ELMI_JOBS}


class JobIn(BaseModel):
    # An id links an existing label class (keeping its annotations); none creates a new one.
    id: int | None = None
    name: str = Field(min_length=1, max_length=64)
    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    kind: Literal["histo", "elmi"] = "histo"


class ProjectIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    folders: list[str] | None = None
    jobs: list[JobIn] | None = None


class Sharing(BaseModel):
    visibility: Literal["private", "people", "everyone"]
    members: list[str] = []


class Folders(BaseModel):
    folders: list[str]


def normalize(folders: list[str]) -> list[str]:
    # A folder inside another adds nothing; a parent replaces the folders inside it.
    out: list[str] = []
    for f in folders:
        if f in out or any(a in out for a in ancestors(f)):
            continue
        out = [r for r in out if f not in ancestors(r)] + [f]
    return out


def _path(folder_id: str) -> str:
    try:
        return folder_path(folder_id)
    except httpx.HTTPError:
        return folder_id


def _folder_json(folder_id: str) -> dict:
    return {"id": folder_id, "path": _path(folder_id), "kind": folder_kind(folder_id)}


def _jobs(db: Session, project_id: int) -> list[dict]:
    rows = db.execute(
        select(Job, ProjectJob.color)
        .join(ProjectJob, ProjectJob.job_id == Job.id)
        .where(ProjectJob.project_id == project_id)
        .order_by(literal_column("project_jobs.rowid"))
    )
    return [_job_json(job, color) for job, color in rows]


def _job_json(job: Job, color: str | None = None) -> dict:
    return {"id": job.id, "name": job.name, "color": color or job.color, "kind": job.kind}


def _scope(db: Session, folders: list[str]) -> tuple[list[str] | None, bool]:
    # (ids, known); ids None: no folders, so the project covers every image. Unknown until each
    # folder was listed in the background.
    if not folders:
        return None, True
    items = listed(db, folders)
    return (None, False) if items is None else ([it["_id"] for it in items], True)


def indexed_ids(db: Session, project: Project) -> list[str] | None:
    folders = roots(db, project.id)
    ids, known = _scope(db, folders)
    if not known:
        indexing = "Still indexing this project's folders, try again in a moment."
        raise HTTPException(409, listing_error(folders) or indexing)
    return ids


def outside(db: Session, project: Project, item_id: str) -> bool:
    folders = roots(db, project.id)
    ids, known = _scope(db, folders)
    if known:
        return ids is not None and item_id not in ids
    # While a folder is indexed, Girder says where the image is filed, once per image.
    try:
        folder = item_folder(item_id)
        return bool(folder) and not inside(folder, folders)
    except httpx.HTTPError:
        return False


def _count(db: Session, user_id: int, item_ids: list[str] | None) -> int:
    query = select(func.count()).select_from(Annotation).where(Annotation.user_id == user_id)
    if item_ids is not None:
        query = query.where(among(Annotation.item_id, item_ids))
    return db.scalar(query)


def project_json(db: Session, project: Project, user: User) -> dict:
    folders = roots(db, project.id)
    ids, known = _scope(db, folders)
    owner = db.get(User, project.owner_id) if project.owner_id else None
    members = db.scalars(
        select(User.username)
        .join(ProjectMember, ProjectMember.user_id == User.id)
        .where(ProjectMember.project_id == project.id)
        .order_by(User.username)
    )
    opened = db.get(ProjectOpen, (project.id, user.id))
    layer = layer_id(project, user)
    return {
        "id": project.id,
        "name": project.name,
        "visibility": project.visibility,
        "owner": owner.username if owner else None,
        "is_owner": project.owner_id == user.id,
        "shared_layer": layer != user.id,
        "has_layer": project.layer_user_id is not None,
        "folders": [_folder_json(f) for f in folders],
        "jobs": _jobs(db, project.id),
        "members": list(members),
        # Counts stay empty while a folder's listing failed, until it is refreshed.
        "listing_error": None if known else listing_error(folders),
        "image_count": len(ids) if known and ids is not None else None,
        "annotation_count": _count(db, layer, ids) if known else None,
        "my_annotation_count": _count(db, user.id, ids) if known else None,
        "opened": opened.opened if opened else None,
    }


def _get(db: Session, project_id: int, user: User, owner: bool = False) -> Project:
    project = db.get(Project, project_id)
    if not project or not can_open(db, project, user):
        raise HTTPException(404, "project not found")
    if owner and project.owner_id != user.id:
        raise HTTPException(403, "Only the project owner can change this.")
    return project


def _set_folders(db: Session, project: Project, folders: list[str]) -> None:
    db.execute(delete(ProjectFolder).where(ProjectFolder.project_id == project.id))
    db.add_all(ProjectFolder(project_id=project.id, folder_id=f) for f in folders)


def _set_jobs(db: Session, project: Project, jobs: list[JobIn]) -> None:
    if not jobs:
        raise HTTPException(400, "Add at least one label class.")
    # A recolor stays in this project: the class keeps its own color everywhere else.
    colors: dict[int, str | None] = {}
    for j in jobs:
        if j.id is None:
            job = Job(name=j.name.strip(), color=j.color, kind=j.kind)
            db.add(job)
            db.flush()
        elif not (job := db.get(Job, j.id)):
            raise HTTPException(404, "job not found")
        colors.setdefault(job.id, None if j.color.lower() == job.color.lower() else j.color)
    db.execute(delete(ProjectJob).where(ProjectJob.project_id == project.id))
    db.flush()
    for job_id, color in colors.items():
        db.add(ProjectJob(project_id=project.id, job_id=job_id, color=color))
        # One at a time so the insertion order (rowid) is the order shown.
        db.flush()


def copy_into_layer(db: Session, project: Project, source_id: int, ids: list[str] | None) -> int:
    # Insert-or-ignore on (layer, image, element id): rerunning never overwrites shared edits.
    a = Annotation.__table__.c
    values = {
        c.name: literal(project.layer_user_id) if c.name == "user_id" else c
        for c in Annotation.__table__.c
        if c.name != "id"
    }
    values["created_by"] = func.coalesce(a.created_by, source_id)
    values["edited_by"] = func.coalesce(a.edited_by, source_id)
    source = select(*values.values()).where(a.user_id == source_id)
    if ids is not None:
        source = source.where(among(a.item_id, ids))
    statement = insert(Annotation).prefix_with("OR IGNORE").from_select(list(values), source)
    return db.execute(statement).rowcount


@router.get("/api/projects")
def list_projects(user: User = Depends(current_user), db: Session = Depends(get_db)) -> list[dict]:
    projects = [p for p in db.scalars(select(Project)) if can_open(db, p, user)]
    rows = [project_json(db, p, user) for p in projects]
    created = {p.id: p.created for p in projects}
    return sorted(rows, key=lambda r: (r["opened"] or 0, created[r["id"]]), reverse=True)


@router.post("/api/projects")
def create_project(
    body: ProjectIn, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    if not body.name:
        raise HTTPException(400, "Name the project.")
    # Ask Girder before writing, so the database is never locked while it answers.
    folders = normalize(body.folders or [])
    project = Project(name=body.name.strip(), owner_id=user.id, created=time.time())
    db.add(project)
    db.flush()
    _set_folders(db, project, folders)
    _set_jobs(db, project, body.jobs or [])
    db.commit()
    return project_json(db, project, user)


@router.get("/api/projects/{project_id}")
def get_project(
    project_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    return project_json(db, _get(db, project_id, user), user)


@router.patch("/api/projects/{project_id}")
def update_project(
    project_id: int,
    body: ProjectIn,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    project = _get(db, project_id, user, owner=True)
    if body.name:
        project.name = body.name.strip()
    if body.folders is not None:
        _set_folders(db, project, normalize(body.folders))
    if body.jobs is not None:
        _set_jobs(db, project, body.jobs)
    db.commit()
    return project_json(db, project, user)


@router.put("/api/projects/{project_id}/sharing")
def share_project(
    project_id: int,
    body: Sharing,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    project = _get(db, project_id, user, owner=True)
    names = set(body.members) - {user.username}
    members = list(
        db.scalars(
            select(User).where(User.username.in_(names), User.password_hash != LOCKED_PASSWORD)
        )
    )
    if missing := names - {m.username for m in members}:
        raise HTTPException(404, f"No user named {', '.join(sorted(missing))}.")
    # Sharing for the first time starts a shared layer from the owner's annotations; it is kept
    # when the project goes private again, and sharing again reuses it.
    first_share = body.visibility != "private" and not project.layer_user_id
    ids = indexed_ids(db, project) if first_share else None
    db.execute(delete(ProjectMember).where(ProjectMember.project_id == project.id))
    db.add_all(ProjectMember(project_id=project.id, user_id=m.id) for m in members)
    project.visibility = body.visibility
    if first_share:
        # Reserved in auth. The suffix keeps it unique when a deleted project's id is reused.
        name = f"project-{project.id}-{secrets.token_hex(4)}"
        layer = User(username=name, password_hash=LOCKED_PASSWORD)
        db.add(layer)
        db.flush()
        project.layer_user_id = layer.id
        copy_into_layer(db, project, user.id, ids)
    db.commit()
    return project_json(db, project, user)


@router.post("/api/projects/{project_id}/copy-annotations")
def copy_annotations(
    project_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    project = _get(db, project_id, user)
    if layer_id(project, user) == user.id:
        raise HTTPException(400, "This project has no shared layer.")
    copied = copy_into_layer(db, project, user.id, indexed_ids(db, project))
    db.commit()
    return {"copied": copied, "project": project_json(db, project, user)}


@router.post("/api/projects/{project_id}/open")
def open_project(
    project_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    project = _get(db, project_id, user)
    user.last_project_id = project.id
    db.merge(ProjectOpen(project_id=project.id, user_id=user.id, opened=time.time()))
    db.commit()
    return project_json(db, project, user)


@router.delete("/api/projects/{project_id}")
def delete_project(
    project_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    project = _get(db, project_id, user, owner=True)
    # Annotations, including the shared layer's, are kept; only the project's view goes.
    visits = select(PatchVisit.id).where(PatchVisit.project_id == project.id)
    db.execute(update(User).where(User.current_visit_id.in_(visits)).values(current_visit_id=None))
    db.execute(update(User).where(User.last_project_id == project.id).values(last_project_id=None))
    db.execute(delete(PatchVisit).where(PatchVisit.project_id == project.id))
    for table in (ProjectFolder, ProjectJob, ProjectMember, ProjectOpen):
        db.execute(delete(table).where(table.project_id == project.id))
    db.delete(project)
    db.commit()
    return {"ok": True}


@router.post("/folders/resolve")
def resolve_folders(body: Folders, _user: User = Depends(current_user)) -> list[dict]:
    return [_folder_json(f) for f in normalize(body.folders)]


@router.get("/folders")
def folders(
    parent_id: str | None = None,
    scoped: bool = False,
    project: int | None = None,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    # Scoped to the current project, the browser starts at (and cannot leave) its folders.
    scope = current_project(project, user, db) if scoped else None
    folders = roots(db, scope.id) if scope else []
    if not folders:
        return list_folders(parent_id)
    key = union_key(scope)
    if not parent_id or parent_id == key:
        return {
            "id": key,
            "name": scope.name,
            "parent_id": None,
            "root": True,
            "n_items": 0,
            "children": [folder_row(f) for f in folders],
        }
    level = list_folders(parent_id)
    if parent_id in folders:
        level["parent_id"] = key
    return level


@router.get("/jobs")
def list_jobs(
    project: Project = Depends(current_project),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[dict]:
    # The project's classes, plus those of the annotations visible here so they keep their names
    # and colors. Other people's classes stay out.
    own = _jobs(db, project.id)
    used = select(Annotation.job_id).where(Annotation.user_id == layer_id(project, user))
    item_ids, known = _scope(db, roots(db, project.id))
    if known and item_ids is not None:
        used = used.where(among(Annotation.item_id, item_ids))
    ids = [j["id"] for j in own]
    others = db.scalars(select(Job).where(Job.id.in_(used), Job.id.not_in(ids)).order_by(Job.id))
    return [{**j, "in_project": True} for j in own] + [
        {**_job_json(j), "in_project": False} for j in others
    ]


@router.get("/jobs/presets")
def job_presets(_user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    first = preset_ids(db)
    return {
        preset: [_job_json(db.get(Job, first[name])) for name, _ in jobs if name in first]
        for preset, jobs in PRESETS.items()
    }
