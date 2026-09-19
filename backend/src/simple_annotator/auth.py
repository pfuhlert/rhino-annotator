import hashlib
import secrets

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.security import APIKeyCookie
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from simple_annotator.config import COOKIE_NAME
from simple_annotator.db import get_db
from simple_annotator.models import Annotation, Job, User
from simple_annotator.models import Session as AuthSession

router = APIRouter(prefix="/auth")
me_router = APIRouter()
cookie_scheme = APIKeyCookie(name=COOKIE_NAME, auto_error=False)


class Creds(BaseModel):
    username: str
    password: str


class MePatch(BaseModel):
    last_job_id: int


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
    if not token:
        raise HTTPException(401, "not logged in")
    row = db.get(AuthSession, token)
    if not row:
        raise HTTPException(401, "not logged in")
    user = db.get(User, row.user_id)
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
    return {"id": user.id, "username": user.username, "last_job_id": user.last_job_id}


@router.post("/login")
def login(body: Creds, response: Response, db: Session = Depends(get_db)) -> dict:
    user = db.scalar(select(User).where(User.username == body.username))
    if not user or not _verify(body.password, user.password_hash):
        raise HTTPException(401, "invalid credentials")
    _set_session(db, user, response)
    return {"id": user.id, "username": user.username, "last_job_id": user.last_job_id}


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


@me_router.get("/me")
def me(user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    done = db.scalar(
        select(func.count()).select_from(Annotation).where(Annotation.user_id == user.id)
    )
    return {
        "id": user.id,
        "username": user.username,
        "last_job_id": user.last_job_id,
        "done_count": done or 0,
    }


@me_router.patch("/me")
def patch_me(
    body: MePatch, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    if not db.get(Job, body.last_job_id):
        raise HTTPException(404, "job not found")
    user.last_job_id = body.last_job_id
    db.commit()
    return {"id": user.id, "username": user.username, "last_job_id": user.last_job_id}
