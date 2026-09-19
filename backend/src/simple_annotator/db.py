from collections.abc import Generator

from sqlalchemy import create_engine, event, select, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from simple_annotator.config import sqlite_path
from simple_annotator.models import Base, Job

SEED_JOBS = (
    ("glomerulus", "#e11d48"),
    ("tubule", "#2563eb"),
    ("vessel", "#059669"),
    ("other", "#d97706"),
)

_engine: Engine | None = None
_SessionLocal: sessionmaker | None = None


def get_engine() -> Engine:
    global _engine, _SessionLocal
    if _engine is None:
        _engine = create_engine(
            f"sqlite:///{sqlite_path()}",
            connect_args={"check_same_thread": False},
        )

        @event.listens_for(_engine, "connect")
        def _fk(dbapi_conn, _rec):
            dbapi_conn.execute("PRAGMA foreign_keys=ON")

        _SessionLocal = sessionmaker(bind=_engine)
    return _engine


def session_factory() -> sessionmaker:
    get_engine()
    assert _SessionLocal is not None
    return _SessionLocal


def reset_engine() -> None:
    global _engine, _SessionLocal
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _SessionLocal = None


def _migrate_visit_cursor(engine: Engine) -> None:
    with engine.begin() as conn:
        cols = {row[1] for row in conn.execute(text("PRAGMA table_info(users)"))}
        if "current_visit_id" not in cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN current_visit_id INTEGER"))
        tables = {
            row[0]
            for row in conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'"))
        }
        if "visit_cursors" in tables:
            conn.execute(
                text(
                    """
                    UPDATE users SET current_visit_id = (
                        SELECT visit_id FROM visit_cursors WHERE visit_cursors.user_id = users.id
                    )
                    WHERE current_visit_id IS NULL
                    """
                )
            )
            conn.execute(text("DROP TABLE visit_cursors"))


def init_db() -> None:
    engine = get_engine()
    Base.metadata.create_all(engine)
    _migrate_visit_cursor(engine)
    with session_factory()() as db:
        if db.scalar(select(Job).limit(1)):
            return
        for name, color in SEED_JOBS:
            db.add(Job(name=name, color=color))
        db.commit()


def get_db() -> Generator[Session]:
    db = session_factory()()
    try:
        yield db
    finally:
        db.close()
