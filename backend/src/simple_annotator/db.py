import fcntl
import json
import os
import sqlite3
import time
from collections.abc import Generator
from functools import wraps

from sqlalchemy import create_engine, event, select, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from simple_annotator.annotations import element_row, shift
from simple_annotator.config import sqlite_path
from simple_annotator.girder import PLACEHOLDER_FOLDER
from simple_annotator.models import Annotation, Base, Job

SEED_JOBS = (
    ("Glomerulus", "#e11d48"),
    ("Tubule", "#2563eb"),
    ("Vessel", "#059669"),
    ("Other", "#d97706"),
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


def retry_sqlite_busy(operation=None, *, attempts: int | None = None):
    if operation is None:
        return lambda fn: retry_sqlite_busy(fn, attempts=attempts)

    @wraps(operation)
    def run(*args, **kwargs):
        failures = 0
        while True:
            try:
                return operation(*args, **kwargs)
            except OperationalError as exc:
                code = getattr(exc.orig, "sqlite_errorcode", 0) & 0xFF
                if code not in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
                    raise
                failures += 1
                if attempts is not None and failures >= attempts:
                    raise
                time.sleep(0.1)

    return run


def reset_engine() -> None:
    global _engine, _SessionLocal
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _SessionLocal = None


def _annotations_to_rows(conn, columns: set[str]) -> None:
    # The old table stays as a backup of the annotations before the rewrite.
    conn.execute(text("ALTER TABLE annotations RENAME TO annotations_json"))
    Annotation.__table__.create(conn)
    if "patch_id" in columns:
        query = """
            SELECT a.id, a.user_id, a.job_id, a.elements, p.girder_item_id AS item_id,
                   p."left" AS dx, p.top AS dy
            FROM annotations_json a JOIN patches p ON p.id = a.patch_id ORDER BY a.id
        """
    else:
        query = """
            SELECT id, user_id, job_id, elements, item_id, 0 AS dx, 0 AS dy
            FROM annotations_json ORDER BY id
        """
    rows = {}
    for old in conn.execute(text(query)):
        for i, el in enumerate(json.loads(old.elements)):
            el.setdefault("id", f"legacy-{old.id}-{i}")
            moved = shift(el, old.dx, old.dy)
            rows[old.user_id, old.item_id, el["id"]] = element_row(
                old.item_id, old.user_id, old.job_id, moved
            )
    if rows:
        conn.execute(Annotation.__table__.insert(), list(rows.values()))


def _migrate(engine: Engine) -> None:
    with engine.begin() as conn:
        # pysqlite leaves schema changes outside a transaction unless one is opened explicitly.
        conn.execute(text("BEGIN IMMEDIATE"))
        cols = {row[1] for row in conn.execute(text("PRAGMA table_info(annotations)"))}
        if "elements" in cols:
            _annotations_to_rows(conn, cols)
        ai_cols = {row[1] for row in conn.execute(text("PRAGMA table_info(ai_tasks)"))}
        if ai_cols and "finished" not in ai_cols:
            conn.execute(text("ALTER TABLE ai_tasks ADD COLUMN finished FLOAT"))
        user_cols = {row[1] for row in conn.execute(text("PRAGMA table_info(users)"))}
        if "current_visit_id" not in user_cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN current_visit_id INTEGER"))
        if "last_folder_id" not in user_cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN last_folder_id VARCHAR(64)"))
        if "stain_filter" not in user_cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN stain_filter TEXT"))
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
        patch_cols = {row[1] for row in conn.execute(text("PRAGMA table_info(patches)"))}
        if patch_cols and "grid" not in patch_cols:
            conn.execute(text("ALTER TABLE patches ADD COLUMN grid VARCHAR(64)"))
            conn.execute(text("CREATE INDEX ix_patches_grid ON patches (grid)"))
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
            jobs = {j.name: j for j in db.scalars(select(Job)).all()}
            for name, color in (*SEED_JOBS, *ELMI_JOBS):
                if name in jobs:
                    continue
                if name.lower() in jobs:
                    jobs[name.lower()].name = name
                else:
                    db.add(Job(name=name, color=color))
            db.commit()


def get_db() -> Generator[Session]:
    db = session_factory()()
    try:
        yield db
    finally:
        db.close()
