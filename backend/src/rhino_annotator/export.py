import csv
import io
import json
from datetime import UTC, datetime, tzinfo
from itertools import groupby
from urllib.parse import quote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import numpy as np
import shapely
from fastapi import APIRouter, Depends, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from rhino_annotator.auth import current_user
from rhino_annotator.db import among, get_db
from rhino_annotator.girder import image_nm_per_px, item_folder_path
from rhino_annotator.models import (
    Annotation,
    Completion,
    Job,
    Project,
    ProjectJob,
    Score,
    Slide,
    User,
)
from rhino_annotator.projects import indexed_ids
from rhino_annotator.scope import current_project, layer_id

router = APIRouter(prefix="/annotations")

COLUMNS = [
    "folder",
    "image",
    "image_id",
    "job",
    "type",
    "annotation_id",
    "score",
    "x",
    "y",
    "area_px",
    "area_um2",
    "perimeter_px",
    "perimeter_um",
    "feret_max_px",
    "feret_max_um",
    "feret_min_px",
    "feret_min_um",
    "created",
    "updated",
    "created_by",
    "edited_by",
    "geometry",
]


def local_time(t: float | None, zone: tzinfo) -> str:
    return datetime.fromtimestamp(t, zone).isoformat(timespec="seconds") if t else ""


def shape(kind: str, geometry: dict) -> shapely.Geometry:
    points = geometry["points"]
    if kind == "point":
        return shapely.Point(points[0])
    if len(points) < 3:
        return shapely.MultiPoint(points)
    polygon = shapely.Polygon(points, [h for h in geometry.get("holes", []) if len(h) >= 3])
    # The viewer fills self-crossing outlines even-odd; repairing measures what it shows.
    return polygon if polygon.is_valid else shapely.make_valid(polygon, method="structure")


def feret(geometry: shapely.Geometry) -> tuple[float, float]:
    hull = geometry.convex_hull
    if not isinstance(hull, shapely.Polygon):
        return 0.0, hull.length
    pts = shapely.get_coordinates(hull.exterior)[:-1]
    longest = np.max(np.linalg.norm(pts[:, None] - pts[None], axis=-1))
    edges = np.roll(pts, -1, axis=0) - pts
    normals = np.stack([-edges[:, 1], edges[:, 0]], axis=1) / np.linalg.norm(edges, axis=1)[:, None]
    # Rotating calipers: the narrowest width lies against one of the hull's edges.
    widths = np.abs(np.einsum("ijk,ik->ij", pts[None] - pts[:, None], normals)).max(axis=1)
    return float(widths.min()), float(longest)


def measures(geometry: shapely.Geometry, um_per_px: float | None) -> dict:
    area, perimeter = geometry.area, geometry.length
    fmin, fmax = feret(geometry)
    lengths = {"perimeter": perimeter, "feret_max": fmax, "feret_min": fmin}
    return {
        "area_px": round(area, 2),
        "area_um2": round(area * um_per_px**2, 4) if um_per_px else "",
        **{f"{k}_px": round(v, 2) for k, v in lengths.items()},
        **{f"{k}_um": round(v * um_per_px, 4) if um_per_px else "" for k, v in lengths.items()},
    }


def rows(db: Session, project: Project, layer: int, item_ids: list[str] | None, zone: tzinfo):
    jobs = dict(db.execute(select(Job.id, Job.name)).all())
    renamed = select(ProjectJob.job_id, ProjectJob.name).where(
        ProjectJob.project_id == project.id, ProjectJob.name.is_not(None)
    )
    jobs.update(db.execute(renamed).all())
    users = dict(db.execute(select(User.id, User.username)).all())
    query = select(Annotation).where(Annotation.user_id == layer)
    if item_ids is not None:
        query = query.where(among(Annotation.item_id, item_ids))
    annotations = db.scalars(query.order_by(Annotation.item_id, Annotation.id))
    for item_id, group in groupby(annotations, key=lambda a: a.item_id):
        slide = db.get(Slide, item_id)
        nm_per_px = slide and (slide.nm_per_px if slide.histo else image_nm_per_px(item_id))
        um_per_px = nm_per_px / 1e3 if nm_per_px else None
        image = {
            "folder": item_folder_path(item_id),
            "image": slide.name if slide else "",
            "image_id": item_id,
        }
        for a in group:
            geometry = shape(a.type, json.loads(a.geometry))
            yield {
                **image,
                "job": jobs.get(a.job_id, ""),
                "type": a.type,
                "annotation_id": a.element_id,
                "x": round(geometry.centroid.x, 2),
                "y": round(geometry.centroid.y, 2),
                **(measures(geometry, um_per_px) if a.type == "polygon" else {}),
                "created": local_time(a.created, zone),
                "updated": local_time(a.updated, zone),
                "created_by": users.get(a.created_by, ""),
                "edited_by": users.get(a.edited_by, ""),
                "geometry": shapely.to_wkt(geometry, rounding_precision=-1),
            }
    yield from score_rows(db, layer, item_ids, zone, jobs, users)
    yield from completion_rows(db, layer, item_ids, zone, users)


def completion_rows(db: Session, layer: int, item_ids, zone: tzinfo, users: dict):
    # One row per finished image, also when it has no masks: unmasked area there is background.
    query = select(Completion).where(Completion.user_id == layer)
    if item_ids is not None:
        query = query.where(among(Completion.item_id, item_ids))
    for c in db.scalars(query.order_by(Completion.item_id)):
        slide = db.get(Slide, c.item_id)
        yield {
            "folder": item_folder_path(c.item_id),
            "image": slide.name if slide else "",
            "image_id": c.item_id,
            "type": "complete",
            "created": local_time(c.created, zone),
            "created_by": users.get(c.created_by, ""),
        }


def score_rows(db: Session, layer: int, item_ids, zone: tzinfo, jobs: dict, users: dict):
    # One row per scored image and score class; an empty score means not scorable.
    query = select(Score).where(Score.user_id == layer)
    if item_ids is not None:
        query = query.where(among(Score.item_id, item_ids))
    for s in db.scalars(query.order_by(Score.item_id, Score.job_id)):
        slide = db.get(Slide, s.item_id)
        yield {
            "folder": item_folder_path(s.item_id),
            "image": slide.name if slide else "",
            "image_id": s.item_id,
            "job": jobs.get(s.job_id, ""),
            "type": "score",
            "score": "" if s.value is None else s.value,
            "created": local_time(s.created, zone),
            "updated": local_time(s.updated, zone),
            "created_by": users.get(s.created_by, ""),
            "edited_by": users.get(s.edited_by, ""),
        }


@router.get("/export.csv")
def export_csv(
    tz: str = "UTC",
    user: User = Depends(current_user),
    project: Project = Depends(current_project),
    db: Session = Depends(get_db),
) -> Response:
    try:
        zone = ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        zone = UTC
    out = io.StringIO()
    writer = csv.DictWriter(out, COLUMNS, restval="")
    writer.writeheader()
    writer.writerows(rows(db, project, layer_id(project, user), indexed_ids(db, project), zone))
    stamp = datetime.now(zone).strftime("%Y-%m-%d_%H-%M-%S")
    filename = f"annotations-{project.name}-{user.username}-{stamp}.csv"
    return Response(
        out.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )
