import csv
import io
import json
from datetime import UTC, datetime
from itertools import groupby
from urllib.parse import quote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import shapely
from fastapi import APIRouter, Depends, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from simple_annotator.auth import current_user
from simple_annotator.db import get_db
from simple_annotator.girder import image_nm_per_px, item_folder_path
from simple_annotator.models import Annotation, Job, Slide, User

router = APIRouter(prefix="/annotations")

COLUMNS = [
    "folder",
    "image",
    "image_id",
    "job",
    "type",
    "annotation_id",
    "x",
    "y",
    "area_px",
    "area_um2",
    "geometry",
]


def shape(kind: str, geometry: dict) -> shapely.Geometry:
    points = geometry["points"]
    if kind == "point":
        return shapely.Point(points[0])
    if len(points) < 3:
        return shapely.MultiPoint(points)
    polygon = shapely.Polygon(points, [h for h in geometry.get("holes", []) if len(h) >= 3])
    # The viewer fills self-crossing outlines even-odd; repairing measures what it shows.
    return polygon if polygon.is_valid else shapely.make_valid(polygon, method="structure")


def rows(db: Session, user_id: int):
    jobs = dict(db.execute(select(Job.id, Job.name)).all())
    annotations = db.scalars(
        select(Annotation)
        .where(Annotation.user_id == user_id)
        .order_by(Annotation.item_id, Annotation.id)
    )
    for item_id, group in groupby(annotations, key=lambda a: a.item_id):
        slide = db.get(Slide, item_id)
        nm_per_px = slide and (slide.nm_per_px if slide.histo else image_nm_per_px(item_id))
        um2_per_px = nm_per_px**2 / 1e6 if nm_per_px else None
        image = {
            "folder": item_folder_path(item_id),
            "image": slide.name if slide else "",
            "image_id": item_id,
        }
        for a in group:
            geometry = shape(a.type, json.loads(a.geometry))
            area = geometry.area if a.type == "polygon" else None
            yield {
                **image,
                "job": jobs.get(a.job_id, ""),
                "type": a.type,
                "annotation_id": a.element_id,
                "x": round(geometry.centroid.x, 2),
                "y": round(geometry.centroid.y, 2),
                "area_px": "" if area is None else round(area, 2),
                "area_um2": round(area * um2_per_px, 4) if area is not None and um2_per_px else "",
                "geometry": shapely.to_wkt(geometry, rounding_precision=-1),
            }


@router.get("/export.csv")
def export_csv(
    tz: str = "UTC", user: User = Depends(current_user), db: Session = Depends(get_db)
) -> Response:
    out = io.StringIO()
    writer = csv.DictWriter(out, COLUMNS)
    writer.writeheader()
    writer.writerows(rows(db, user.id))
    try:
        zone = ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        zone = UTC
    stamp = datetime.now(zone).strftime("%Y-%m-%d_%H-%M-%S")
    filename = f"annotations-{user.username}-{stamp}.csv"
    return Response(
        out.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"},
    )
