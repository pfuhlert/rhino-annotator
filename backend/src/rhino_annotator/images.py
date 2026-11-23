import json
import logging
import math
import re
import threading
import time
from collections import Counter
from functools import lru_cache

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from rhino_annotator import completions, scores
from rhino_annotator.auth import current_user
from rhino_annotator.db import among, get_db, retry_sqlite_busy, session_factory
from rhino_annotator.girder import (
    PLACEHOLDER_FOLDER,
    get_item,
    girder_enabled,
    item_path,
    thumbnail,
    walk_images,
)
from rhino_annotator.models import (
    WHOLE_GRID,
    Annotation,
    FolderImages,
    Patch,
    PatchVisit,
    Project,
    Slide,
    SlideView,
    User,
)
from rhino_annotator.scope import browse, current_project, layer_id, roots, visited_filter

router = APIRouter(prefix="/images")

POWERS = (1.25, 2.5, 5, 10, 20, 40, 60, 100)
# Girder's histology pixel size is 10x too small, so its magnification is 10x too large.
MAGNIFICATION_ERROR = 10
INDEXING = "Still indexing this folder, try again in a moment."
log = logging.getLogger(__name__)
_scanning: set[str] = set()
# Folders whose last listing failed; they wait for a refresh instead of retrying on every request.
_failed: dict[str, str] = {}
_scan_lock = threading.Lock()
# Walks run at most this many at a time, so browsing many folders does not flood Girder.
_walks = threading.BoundedSemaphore(2)
# A large folder's listing takes most of a second to read, so it is parsed once per scan.
_parsed: dict[str, tuple[float, list[dict]]] = {}
_parsed_lock = threading.Lock()


def natural_key(text: str) -> list:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", text)]


def _meta(item: dict) -> dict:
    return item.get("meta") or {}


def group_key(item: dict) -> str:
    return str(_meta(item).get("case_id") or item.get("folder_name") or "")


def staining(item: dict) -> str | None:
    return _meta(item).get("staining") or None


def _positive(value) -> float | None:
    return (
        value
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0
        else None
    )


def magnification(item: dict) -> float | None:
    # Histology slides carry image_magnification; electron microscopy images their magnification.
    if value := _positive(_meta(item).get("image_magnification")):
        actual = value / MAGNIFICATION_ERROR
        return min(POWERS, key=lambda power: abs(math.log(power / actual)))
    return _positive(_meta(item).get("magnification"))


def matches(item: dict, stains: list[str | None], mags: list[float | None] = ()) -> bool:
    return (not stains or staining(item) in stains) and (not mags or magnification(item) in mags)


def _in_girder(folder_id: str) -> bool:
    return girder_enabled() and folder_id != PLACEHOLDER_FOLDER


@retry_sqlite_busy(attempts=50)
def _store(folder_id: str, images: list[dict]) -> None:
    with session_factory()() as db:
        data = json.dumps(images, separators=(",", ":"))
        db.merge(FolderImages(folder_id=folder_id, images=data, scanned=time.time()))
        db.commit()


def _scan(folder_id: str) -> None:
    # Girder answers before the database is written, so the write lock is held only briefly.
    try:
        with _walks:
            images = walk_images(folder_id)
        _store(folder_id, images)
        _failed.pop(folder_id, None)
    except Exception:
        # The last listing, if any, stays in place.
        log.exception("Could not list the images under %s", folder_id)
        _failed[folder_id] = "Could not list this folder's images. Refresh it to try again."
    finally:
        with _scan_lock:
            _scanning.discard(folder_id)


def request_scan(folder_id: str) -> None:
    # At most one listing per folder at a time; later requests reuse it.
    with _scan_lock:
        if folder_id in _scanning or not _in_girder(folder_id):
            return
        _scanning.add(folder_id)
    threading.Thread(target=_scan, args=(folder_id,), daemon=True).start()


def scanning(folder_ids: list[str]) -> bool:
    with _scan_lock:
        return any(f in _scanning for f in folder_ids)


def folder_listing(db: Session, folder_id: str) -> list[dict] | None:
    # The stored listing, redone only on refresh; None until the folder was listed once.
    if not _in_girder(folder_id):
        return [get_item(PLACEHOLDER_FOLDER)]
    scanned = db.scalar(select(FolderImages.scanned).where(FolderImages.folder_id == folder_id))
    if scanned is None:
        if folder_id not in _failed:
            request_scan(folder_id)
        return None
    cached = _parsed.get(folder_id)
    if cached and cached[0] == scanned:
        return cached[1]
    images = json.loads(
        db.scalar(select(FolderImages.images).where(FolderImages.folder_id == folder_id))
    )
    with _parsed_lock:
        # A refresh replaces the folder's old copy; past 32 folders, the oldest one goes.
        _parsed.pop(folder_id, None)
        if len(_parsed) >= 32:
            del _parsed[next(iter(_parsed))]
        _parsed[folder_id] = (scanned, images)
    return images


def listing_error(folder_ids: list[str]) -> str | None:
    # A folder still being listed may yet fill in the rest, so its siblings' failures wait.
    if scanning(folder_ids):
        return None
    return next((_failed[f] for f in folder_ids if f in _failed), None)


def listed(db: Session, folder_ids: list[str]) -> list[dict] | None:
    # Every folder starts listing at once; None until all of them were listed.
    listings = [folder_listing(db, f) for f in folder_ids]
    if any(images is None for images in listings):
        return None
    # A project's folders never nest, but one image can still be filed in two of them.
    return list({it["_id"]: it for images in listings for it in images}.values())


def ordered_items(db: Session, folder_ids: list[str]) -> list[dict] | None:
    items = listed(db, folder_ids)
    if items is None:
        if error := listing_error(folder_ids):
            raise HTTPException(502, error)
        return None
    if not items:
        raise HTTPException(400, "This dataset contains no images.")
    # The exact group breaks natural-sort ties ("case-2", "case-02") so groups stay contiguous.
    return sorted(
        items,
        key=lambda it: (natural_key(group_key(it)), group_key(it), natural_key(it["name"])),
    )


@router.get("")
def list_images(
    user: User = Depends(current_user),
    project: Project = Depends(current_project),
    db: Session = Depends(get_db),
) -> dict:
    key, folders = browse(db, user, project)
    items = ordered_items(db, folders)
    if items is None:
        return {
            "folder_id": key,
            "indexing": True,
            "listing_error": None,
            "items": [],
            "stains": [],
            "magnifications": [],
        }
    ids = [item["_id"] for item in items]
    current_grid = (Slide.item_id == Patch.girder_item_id) & (Slide.grid == Patch.grid)
    regions = dict(
        db.execute(
            select(Patch.girder_item_id, func.count())
            .join(Slide, current_grid)
            .where(among(Patch.girder_item_id, ids))
            .group_by(Patch.girder_item_id)
        ).all()
    )
    visited = dict(
        db.execute(
            select(Patch.girder_item_id, func.count(func.distinct(Patch.id)))
            .join(Slide, current_grid)
            .join(PatchVisit, PatchVisit.patch_id == Patch.id)
            .where(visited_filter(project, user), among(Patch.girder_item_id, ids))
            .group_by(Patch.girder_item_id)
        ).all()
    )
    # Known only once a slide was opened.
    histo = set(db.scalars(select(Slide.item_id).where(Slide.histo, among(Slide.item_id, ids))))
    splits = dict(
        db.execute(
            select(SlideView.item_id, SlideView.split).where(
                SlideView.user_id == user.id, among(SlideView.item_id, ids)
            )
        ).all()
    )
    seen_whole = set(
        db.scalars(
            select(Patch.girder_item_id)
            .join(PatchVisit, PatchVisit.patch_id == Patch.id)
            .where(
                visited_filter(project, user),
                Patch.grid == WHOLE_GRID,
                among(Patch.girder_item_id, ids),
            )
        )
    )

    # Regions and visited ones in this user's layout, and whether a histology slide is split.
    def progress(item_id: str) -> dict:
        n, seen = regions.get(item_id), visited.get(item_id, 0)
        if item_id not in histo:
            return {"regions": n, "visited": seen, "split": None}
        # A whole-slide visit covers every tissue region; visiting every region covers the whole.
        done = item_id in seen_whole or bool(n and seen >= n)
        if splits.get(item_id, user.split_histo):
            return {"regions": n, "visited": n if done else seen, "split": True}
        return {"regions": 1, "visited": int(done), "split": False}

    annotations = dict(
        db.execute(
            select(Annotation.item_id, func.count())
            .where(Annotation.user_id == layer_id(project, user), among(Annotation.item_id, ids))
            .group_by(Annotation.item_id)
        ).all()
    )
    scored = scores.counts(db, layer_id(project, user), ids)
    complete = completions.completed(db, layer_id(project, user), ids)
    stains = Counter(staining(item) for item in items)
    mags = Counter(magnification(item) for item in items)
    return {
        "folder_id": key,
        # A refresh being listed in the background.
        "indexing": scanning(folders),
        # A failed refresh, which keeps the last listing.
        "listing_error": listing_error(folders),
        "items": [
            {
                "id": item["_id"],
                "name": item["name"],
                "group": group_key(item),
                "staining": staining(item),
                "magnification": magnification(item),
                "annotations": annotations.get(item["_id"], 0) + scored.get(item["_id"], 0),
                "complete": item["_id"] in complete,
                **progress(item["_id"]),
            }
            for item in items
        ],
        "stains": [{"name": name, "count": n} for name, n in stains.most_common()],
        # Lowest first; images without a magnification last.
        "magnifications": [
            {"value": value, "count": mags[value]}
            for value in sorted(mags, key=lambda v: (v is None, v or 0))
        ],
    }


@router.post("/refresh")
def refresh(
    user: User = Depends(current_user),
    project: Project = Depends(current_project),
    db: Session = Depends(get_db),
) -> dict:
    # Lists the browsed folders again, and the project's failed ones, which a subfolder can't
    # reach; the image list keeps the old listing meanwhile.
    failed = [f for f in roots(db, project.id) if f in _failed]
    for folder_id in {*browse(db, user, project)[1], *failed}:
        _failed.pop(folder_id, None)
        request_scan(folder_id)
    return {"ok": True}


@router.get("/{item_id}/path")
def image_path(item_id: str, _: User = Depends(current_user)) -> dict:
    if not girder_enabled() or item_id == PLACEHOLDER_FOLDER:
        return {"path": get_item(item_id)["name"]}
    try:
        return {"path": item_path(item_id)}
    except httpx.HTTPStatusError as e:
        if e.response.status_code >= 500:
            raise
        raise HTTPException(404, "Image not found") from e


@lru_cache(maxsize=2048)
def _list_thumbnail(item_id: str, side: int) -> bytes:
    return thumbnail(item_id, side, "JPEG")


# The size is in the URL, so the immutable header stays correct if the list's size changes.
@router.get("/{item_id}/thumbnail")
def list_thumbnail(
    item_id: str, side: int = Query(ge=16, le=512), _user: User = Depends(current_user)
) -> Response:
    try:
        content = _list_thumbnail(item_id, side)
    except httpx.HTTPStatusError as e:
        if e.response.status_code >= 500:
            raise
        raise HTTPException(404, "Image not found") from e
    return Response(
        content=content,
        media_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=2592000, immutable"},
    )
