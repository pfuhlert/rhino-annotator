from sqlalchemy import ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# Shared project layers are users that can never sign in.
LOCKED_PASSWORD = "!$locked"
# The grid of an image other than histology: one patch showing the whole image.
IMAGE_GRID = "v1:whole"
# Grid of the one tile showing a whole histology slide, next to its tissue-region grid.
WHOLE_GRID = "v1:histo-whole"


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    password_hash: Mapped[str] = mapped_column(String(256))
    last_job_id: Mapped[int | None] = mapped_column(ForeignKey("jobs.id"), nullable=True)
    last_folder_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_project_id: Mapped[int | None] = mapped_column(
        ForeignKey("projects.id", use_alter=True), nullable=True
    )
    current_visit_id: Mapped[int | None] = mapped_column(
        ForeignKey("patch_visits.id", use_alter=True), nullable=True
    )
    # Histology slides open as tissue regions unless shown whole; SlideView overrides per slide.
    split_histo: Mapped[bool] = mapped_column(default=True, server_default="1")


class Session(Base):
    __tablename__ = "sessions"

    token: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(64))
    color: Mapped[str] = mapped_column(String(16))
    # Which images the class is for: "histo" (histology slides) or "elmi" (electron microscopy).
    kind: Mapped[str] = mapped_column(String(8), default="histo", server_default="histo")
    # "mask": drawn as points and polygons; "score": one 0-100 value (or not scorable) per image.
    mode: Mapped[str] = mapped_column(String(8), default="mask", server_default="mask")


class Patch(Base):
    __tablename__ = "patches"

    id: Mapped[int] = mapped_column(primary_key=True)
    girder_item_id: Mapped[str] = mapped_column(String(64))
    left: Mapped[int]
    top: Mapped[int]
    width: Mapped[int]
    height: Mapped[int]
    # Signature of the slide grid this patch belongs to.
    grid: Mapped[str] = mapped_column(String(64), index=True)


class FolderImages(Base):
    # The images under a folder when it was last listed, so no request waits on Girder.
    __tablename__ = "folder_images"

    folder_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    # JSON list of each image's id, name, folder and the metadata the image list reads.
    images: Mapped[str] = mapped_column(Text)
    scanned: Mapped[float]


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


class SlideView(Base):
    __tablename__ = "slide_views"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), primary_key=True)
    item_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    split: Mapped[bool]


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
    # Epoch seconds; null for annotations saved before timestamps were recorded.
    created: Mapped[float | None]
    updated: Mapped[float | None]
    # Who saved it; null for annotations saved before projects. A shared layer has many editors.
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    edited_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)


class Score(Base):
    __tablename__ = "scores"
    __table_args__ = (UniqueConstraint("user_id", "item_id", "job_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    item_id: Mapped[str] = mapped_column(String(64), index=True)
    # The annotation layer: the user's own, or a shared project's layer user.
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id"))
    # 0-100; null marks the image as not scorable for this class.
    value: Mapped[int | None]
    created: Mapped[float]
    updated: Mapped[float]
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    edited_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created: Mapped[float]
    visibility: Mapped[str] = mapped_column(String(16), default="private")
    # Synthetic user holding the shared annotations once the project was first shared.
    layer_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)


class ProjectFolder(Base):
    __tablename__ = "project_folders"

    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), primary_key=True)
    folder_id: Mapped[str] = mapped_column(String(64), primary_key=True)


class ProjectJob(Base):
    __tablename__ = "project_jobs"

    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), primary_key=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id"), primary_key=True)
    # The class's color in this project, when it differs from the class's own.
    color: Mapped[str | None] = mapped_column(String(16))


class ProjectMember(Base):
    __tablename__ = "project_members"

    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), primary_key=True)


class ProjectOpen(Base):
    __tablename__ = "project_opens"

    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), primary_key=True)
    opened: Mapped[float]
    # JSON list of stain names; null in the list means "no stain".
    stain_filter: Mapped[str | None] = mapped_column(Text, nullable=True)


class PatchVisit(Base):
    __tablename__ = "patch_visits"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    patch_id: Mapped[int] = mapped_column(ForeignKey("patches.id"))
    folder_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id"), nullable=True)


class AiTask(Base):
    __tablename__ = "ai_tasks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    patch_id: Mapped[int] = mapped_column(ForeignKey("patches.id"), index=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("jobs.id"))
    # The annotation layer the result is saved to; null means the requesting user's own.
    layer_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
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
