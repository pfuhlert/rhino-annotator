from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from simple_annotator.auth import current_user
from simple_annotator.db import get_db
from simple_annotator.models import Job, User

router = APIRouter(prefix="/jobs")


@router.get("")
def list_jobs(_user: User = Depends(current_user), db: Session = Depends(get_db)) -> list[dict]:
    jobs = db.scalars(select(Job).order_by(Job.id)).all()
    return [{"id": j.id, "name": j.name, "color": j.color} for j in jobs]
