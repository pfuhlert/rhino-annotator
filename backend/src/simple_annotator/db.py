import fcntl
import os
from collections.abc import Generator

from sqlalchemy import create_engine, event, select, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from simple_annotator.config import sqlite_path
from simple_annotator.girder import PLACEHOLDER_FOLDER
from simple_annotator.models import Base, Job

SEED_JOBS = (
    ("glomerulus", "#e11d48"),
    ("tubule", "#2563eb"),
    ("vessel", "#059669"),
    ("other", "#d97706"),
)
ELMI_JOBS = (
    ("GBM", "#e11d48"),
    ("Podocyte", "#2563eb"),
    ("Foot process", "#7c3aed"),
    ("Endothelium", "#059669"),
    ("Capillary lumen", "#0891b2"),
    ("Mesangium", "#ca8a04"),
    ("Electron dense deposit", "#ea580c"),
    ("Nucleus", "#db2777"),
    ("Mitochondria", "#4f46e5"),
    ("Other / artifact", "#78716c"),
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


def _migrate(engine: Engine) -> None:
    with engine.begin() as conn:
        ai_cols = {row[1] for row in conn.execute(text("PRAGMA table_info(ai_tasks)"))}
        if ai_cols and "finished" not in ai_cols:
            conn.execute(text("ALTER TABLE ai_tasks ADD COLUMN finished FLOAT"))
        user_cols = {row[1] for row in conn.execute(text("PRAGMA table_info(users)"))}
        if "current_visit_id" not in user_cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN current_visit_id INTEGER"))
        if "last_folder_id" not in user_cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN last_folder_id VARCHAR(64)"))
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
        if "patch_visits" in tables:
            visit_cols = {row[1] for row in conn.execute(text("PRAGMA table_info(patch_visits)"))}
            if "folder_id" not in visit_cols:
                conn.execute(text("ALTER TABLE patch_visits ADD COLUMN folder_id VARCHAR(64)"))
            conn.execute(
                text("""
                    UPDATE patch_visits SET folder_id = CASE
                        WHEN patch_id IN (
                            SELECT id FROM patches WHERE girder_item_id = :placeholder
                        )
                        THEN :placeholder ELSE :legacy_folder END
                    WHERE folder_id IS NULL
                """),
                {
                    "placeholder": PLACEHOLDER_FOLDER,
                    "legacy_folder": os.environ.get("GIRDER_FOLDER_ID") or PLACEHOLDER_FOLDER,
                },
            )
            conn.execute(
                text("""
                    UPDATE users SET last_folder_id = COALESCE(
                        (SELECT folder_id FROM patch_visits WHERE id = users.current_visit_id),
                        (SELECT folder_id FROM patch_visits WHERE user_id = users.id
                         ORDER BY id DESC LIMIT 1)
                    ) WHERE last_folder_id IS NULL
                """)
            )


def init_db() -> None:
    with open(str(sqlite_path()) + ".init.lock", "w") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        engine = get_engine()
        Base.metadata.create_all(engine)
        _migrate(engine)
        with session_factory()() as db:
            have = {j.name for j in db.scalars(select(Job)).all()}
            for name, color in (*SEED_JOBS, *ELMI_JOBS):
                if name not in have:
                    db.add(Job(name=name, color=color))
            db.commit()


def get_db() -> Generator[Session]:
    db = session_factory()()
    try:
        yield db
    finally:
        db.close()
