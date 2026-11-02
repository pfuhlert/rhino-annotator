import fcntl
import json
import os
import sqlite3
import time
from collections.abc import Generator
from functools import wraps

from sqlalchemy import (
    ColumnElement,
    bindparam,
    create_engine,
    event,
    func,
    insert,
    select,
    text,
    update,
)
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from simple_annotator.annotations import element_row, shift
from simple_annotator.config import sqlite_path
from simple_annotator.girder import PLACEHOLDER_FOLDER
from simple_annotator.models import (
    LOCKED_PASSWORD,
    Annotation,
    Base,
    Job,
    PatchVisit,
    Project,
    ProjectJob,
    User,
)

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


def _columns(conn, table: str) -> set[str]:
    return {row[1] for row in conn.execute(text(f"PRAGMA table_info({table})"))}


def _add_columns(conn, table: str, columns: dict[str, str]) -> None:
    existing = _columns(conn, table)
    for name, kind in columns.items():
        if existing and name not in existing:
            conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {kind}"))


def _jobs_without_unique_name(conn) -> None:
    sql = conn.scalar(text("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'"))
    if not sql or "UNIQUE" not in sql.upper():
        return
    # Annotations reference jobs; deferred checks pass once the same ids are back at commit.
    conn.execute(text("PRAGMA defer_foreign_keys=ON"))
    conn.execute(text("CREATE TEMP TABLE jobs_old AS SELECT id, name, color FROM jobs"))
    conn.execute(text("DROP TABLE jobs"))
    Job.__table__.create(conn)
    conn.execute(text("INSERT INTO jobs (id, name, color) SELECT id, name, color FROM jobs_old"))
    conn.execute(text("DROP TABLE jobs_old"))


def _migrate(engine: Engine) -> None:
    with engine.begin() as conn:
        # pysqlite leaves schema changes outside a transaction unless one is opened explicitly.
        conn.execute(text("BEGIN IMMEDIATE"))
        cols = {row[1] for row in conn.execute(text("PRAGMA table_info(annotations)"))}
        if "elements" in cols:
            _annotations_to_rows(conn, cols)
        elif "created" not in cols:
            conn.execute(text("ALTER TABLE annotations ADD COLUMN created FLOAT"))
            conn.execute(text("ALTER TABLE annotations ADD COLUMN updated FLOAT"))
        _add_columns(conn, "annotations", {"created_by": "INTEGER", "edited_by": "INTEGER"})
        _add_columns(conn, "ai_tasks", {"finished": "FLOAT", "layer_id": "INTEGER"})
        before_projects = "last_project_id" not in _columns(conn, "users")
        _add_columns(conn, "users", {"last_project_id": "INTEGER"})
        _add_columns(conn, "patch_visits", {"project_id": "INTEGER"})
        _add_columns(conn, "project_jobs", {"color": "VARCHAR(16)"})
        _add_columns(conn, "project_opens", {"stain_filter": "TEXT"})
        had_kind = "kind" in _columns(conn, "jobs")
        _jobs_without_unique_name(conn)
        if not had_kind:
            _add_columns(conn, "jobs", {"kind": "VARCHAR(8) NOT NULL DEFAULT 'histo'"})
            conn.execute(
                text("UPDATE jobs SET kind = 'elmi' WHERE name IN :names").bindparams(
                    bindparam("names", expanding=True)
                ),
                {"names": [name for name, _ in ELMI_JOBS]},
            )
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
        if before_projects:
            _default_projects(conn)
        # Replaced by folder_images before release.
        conn.execute(text("DROP TABLE IF EXISTS project_images"))


def preset_ids(db: Session | Connection) -> dict[str, int]:
    # Classes may share a name; the preset is the first class with its name.
    names = [name for name, _ in SEED_JOBS + ELMI_JOBS]
    query = select(Job.name, func.min(Job.id)).where(Job.name.in_(names)).group_by(Job.name)
    return dict(db.execute(query).all())


def add_default_project(db: Session | Connection, user_id: int, job_ids=frozenset()) -> int:
    project = insert(Project).values(name="All annotations", owner_id=user_id, created=time.time())
    project_id = db.execute(project).inserted_primary_key[0]
    for job_id in sorted(job_ids | set(preset_ids(db).values())):
        db.execute(insert(ProjectJob).values(project_id=project_id, job_id=job_id))
    return project_id


def _default_projects(conn: Connection) -> None:
    _seed_presets(conn)
    users = conn.scalars(select(User.id).where(User.password_hash != LOCKED_PASSWORD)).all()
    for user_id in users:
        # The classes of the user's own annotations stay in their project; other people's don't.
        used = conn.scalars(select(Annotation.job_id).where(Annotation.user_id == user_id))
        project_id = add_default_project(conn, user_id, frozenset(used))
        conn.execute(update(User).where(User.id == user_id).values(last_project_id=project_id))
        conn.execute(
            update(PatchVisit)
            .where(PatchVisit.user_id == user_id, PatchVisit.project_id.is_(None))
            .values(project_id=project_id)
        )


def init_db() -> None:
    with open(str(sqlite_path()) + ".init.lock", "w") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        engine = get_engine()
        Base.metadata.create_all(engine)
        _migrate(engine)
        with engine.begin() as conn:
            _seed_presets(conn)


def _seed_presets(conn: Connection) -> None:
    jobs = dict(conn.execute(select(Job.name, Job.id)).all())
    presets = [(*job, "histo") for job in SEED_JOBS] + [(*job, "elmi") for job in ELMI_JOBS]
    for name, color, kind in presets:
        if name in jobs:
            continue
        if name.lower() in jobs:
            conn.execute(update(Job).where(Job.id == jobs[name.lower()]).values(name=name))
        else:
            conn.execute(insert(Job).values(name=name, color=color, kind=kind))


def get_db() -> Generator[Session]:
    db = session_factory()()
    try:
        yield db
    finally:
        db.close()


def among(column: ColumnElement, values: list[str]) -> ColumnElement[bool]:
    # One JSON parameter: a large project's image ids exceed SQLite's limit on parameters.
    return column.in_(select(func.json_each(json.dumps(values)).table_valued("value").c.value))
