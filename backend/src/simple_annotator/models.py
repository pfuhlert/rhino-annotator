from sqlalchemy import ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    password_hash: Mapped[str] = mapped_column(String(256))
    last_job_id: Mapped[int | None] = mapped_column(ForeignKey("jobs.id"), nullable=True)
    last_folder_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # JSON list of stain names; null in the list means "no stain".
    stain_filter: Mapped[str | None] = mapped_column(Text, nullable=True)
    current_visit_id: Mapped[int | None] = mapped_column(
        ForeignKey("patch_visits.id", use_alter=True), nullable=True
    )


class Session(Base):
    __tablename__ = "sessions"

    token: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(64), unique=True)
    color: Mapped[str] = mapped_column(String(16))


class Patch(Base):
    __tablename__ = "patches"

    id: Mapped[int] = mapped_column(primary_key=True)
    girder_item_id: Mapped[str] = mapped_column(String(64))
    left: Mapped[int]
    top: Mapped[int]
    width: Mapped[int]
    height: Mapped[int]
    # Signature of the slide grid this tile belongs to; NULL for legacy random crops.
    grid: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)


class Slide(Base):
    __tablename__ = "slides"

    item_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(256))
    width: Mapped[int]
    height: Mapped[int]
    nm_per_px: Mapped[float | None]
    histo: Mapped[bool]
    grid: Mapped[str] = mapped_column(String(64))
    tile_width: Mapped[int]
    tile_height: Mapped[int]
    levels: Mapped[int]


class Annotation(Base):
    __tablename__ = "annotations"
    __table_args__ = (UniqueConstraint("user_id", "item_id", "element_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    element_id: Mapped[str] = mapped_column(String(100))
    item_id: Mapped[str] = mapped_column(String(64))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id"))
    type: Mapped[str] = mapped_column(String(16))
    # JSON points and holes in full-image pixels; the bounding box finds a patch's elements.
    geometry: Mapped[str] = mapped_column(Text)
    x0: Mapped[float]
    y0: Mapped[float]
    x1: Mapped[float]
    y1: Mapped[float]


class PatchVisit(Base):
    __tablename__ = "patch_visits"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    patch_id: Mapped[int] = mapped_column(ForeignKey("patches.id"))
    folder_id: Mapped[str | None] = mapped_column(String(64), nullable=True)


class AiTask(Base):
    __tablename__ = "ai_tasks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    patch_id: Mapped[int] = mapped_column(ForeignKey("patches.id"), index=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id"))
    status: Mapped[str] = mapped_column(String(16), index=True)
    created: Mapped[float]
    input: Mapped[str] = mapped_column(Text)
    error: Mapped[str | None]
    elapsed_ms: Mapped[int | None]
    finished: Mapped[float | None]


class AiWorker(Base):
    __tablename__ = "ai_worker"

    id: Mapped[int] = mapped_column(primary_key=True)
    updated: Mapped[float]
    status: Mapped[str]


class AiEmbedding(Base):
    __tablename__ = "ai_embeddings"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    input: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), index=True)
    created: Mapped[float]
    error: Mapped[str | None]
    data: Mapped[bytes | None] = mapped_column(deferred=True)
