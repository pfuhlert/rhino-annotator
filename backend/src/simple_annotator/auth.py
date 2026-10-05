import hashlib
import json
import secrets

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.security import APIKeyCookie
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from simple_annotator.config import COOKIE_NAME
from simple_annotator.db import ELMI_JOBS, SEED_JOBS, get_db
from simple_annotator.girder import is_elmi_folder, list_folders
from simple_annotator.models import Annotation, Job, User
from simple_annotator.models import Session as AuthSession

router = APIRouter(prefix="/auth")
me_router = APIRouter()
cookie_scheme = APIKeyCookie(name=COOKIE_NAME, auto_error=False)


class Creds(BaseModel):
    username: str
    password: str


class MePatch(BaseModel):
    last_job_id: int | None = None
    last_folder_id: str | None = None
    stain_filter: list[str | None] | None = None


def _hash(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 120_000).hex()
    return f"{salt}${digest}"


def _verify(password: str, stored: str) -> bool:
    salt, _digest = stored.split("$", 1)
    return secrets.compare_digest(stored, _hash(password, salt))


def current_user(
    token: str | None = Depends(cookie_scheme),
    db: Session = Depends(get_db),
) -> User:
    row = db.get(AuthSession, token) if token else None
    user = db.get(User, row.user_id) if row else None
    if not user:
        raise HTTPException(401, "not logged in")
    return user


def _set_session(db: Session, user: User, response: Response) -> None:
    token = secrets.token_hex(32)
    db.add(AuthSession(token=token, user_id=user.id))
    db.commit()
    response.set_cookie(
        COOKIE_NAME, token, httponly=True, samesite="lax", path="/", max_age=7 * 24 * 3600
    )


def _user_json(user: User, done_count: int | None = None) -> dict:
    out = {
        "id": user.id,
        "username": user.username,
        "last_job_id": user.last_job_id,
        "last_folder_id": user.last_folder_id,
        "stain_filter": user_stains(user),
    }
    if done_count is not None:
        out["done_count"] = done_count
    return out


def user_stains(user: User) -> list[str | None]:
    return json.loads(user.stain_filter) if user.stain_filter else []


def require_job(db: Session, job_id: int) -> None:
    if not db.get(Job, job_id):
        raise HTTPException(404, "job not found")


@router.post("/register")
def register(body: Creds, response: Response, db: Session = Depends(get_db)) -> dict:
    if db.scalar(select(User).where(User.username == body.username)):
        raise HTTPException(409, "username taken")
    first_job = db.scalar(select(Job).order_by(Job.id))
    user = User(
        username=body.username,
        password_hash=_hash(body.password),
        last_job_id=first_job.id if first_job else None,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    _set_session(db, user, response)
    return _user_json(user)


@router.post("/login")
def login(body: Creds, response: Response, db: Session = Depends(get_db)) -> dict:
    user = db.scalar(select(User).where(User.username == body.username))
    if not user or not _verify(body.password, user.password_hash):
        raise HTTPException(401, "invalid credentials")
    _set_session(db, user, response)
    return _user_json(user)


@router.post("/logout")
def logout(
    response: Response,
    token: str | None = Depends(cookie_scheme),
    db: Session = Depends(get_db),
) -> dict:
    if token and (row := db.get(AuthSession, token)):
        db.delete(row)
        db.commit()
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


def _done_count(db: Session, user: User) -> int:
    return db.scalar(
        select(func.count()).select_from(Annotation).where(Annotation.user_id == user.id)
    )


@me_router.get("/me")
def me(user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    return _user_json(user, _done_count(db, user))


@me_router.patch("/me")
def patch_me(
    body: MePatch, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    if body.last_job_id is not None:
        require_job(db, body.last_job_id)
        user.last_job_id = body.last_job_id
    if body.last_folder_id is not None and body.last_folder_id != user.last_folder_id:
        user.last_folder_id = body.last_folder_id
        user.stain_filter = None
    if "stain_filter" in body.model_fields_set:
        user.stain_filter = json.dumps(body.stain_filter) if body.stain_filter else None
    db.commit()
    return _user_json(user, _done_count(db, user))


@me_router.get("/folders")
def folders(parent_id: str | None = None, _user: User = Depends(current_user)) -> dict:
    return list_folders(parent_id)


@me_router.get("/jobs")
def list_jobs(user: User = Depends(current_user), db: Session = Depends(get_db)) -> list[dict]:
    names = {n for n, _ in (ELMI_JOBS if is_elmi_folder(user.last_folder_id) else SEED_JOBS)}
    jobs = [j for j in db.scalars(select(Job).order_by(Job.id)).all() if j.name in names]
    return [{"id": j.id, "name": j.name, "color": j.color} for j in jobs]
