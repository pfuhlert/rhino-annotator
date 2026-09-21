import io
import os
import random
from pathlib import Path

import httpx
from PIL import Image, ImageDraw

from simple_annotator.config import CROP_SIZE, FULL_IMAGE_MAX, GIRDER_API_URL

PLACEHOLDER_FOLDER = "placeholder"
_IMAGE_EXT = {".png", ".tif", ".tiff", ".svs", ".jpg", ".jpeg", ".bmp"}

_gc: httpx.Client | None = None
_placeholders: dict[tuple[int, int], bytes] = {}
_images_cache: dict[str, list[dict]] = {}
_kids_cache: dict[tuple[str, str], list[dict]] = {}


def girder_enabled() -> bool:
    return bool(os.environ.get("GIRDER_TOKEN"))


def _client() -> httpx.Client:
    global _gc
    if _gc is None:
        key = os.environ.get("GIRDER_TOKEN", "")
        _gc = httpx.Client(base_url=GIRDER_API_URL.rstrip("/"), timeout=30)
        me = _gc.get("/user/me", headers={"Girder-Token": key})
        token = key
        if not (me.status_code == 200 and me.json()):
            r = _gc.post("/api_key/token", data={"key": key})
            r.raise_for_status()
            token = r.json()["authToken"]["token"]
        _gc.headers["Girder-Token"] = token
    return _gc


def _region(item_id: str, w: int, h: int) -> dict:
    if max(w, h) <= FULL_IMAGE_MAX:
        left, top, width, height = 0, 0, w, h
    else:
        width, height = min(CROP_SIZE, w), min(CROP_SIZE, h)
        left = random.randint(0, max(0, w - width))
        top = random.randint(0, max(0, h - height))
    return {
        "girder_item_id": item_id,
        "left": left,
        "top": top,
        "width": width,
        "height": height,
    }


def _is_image(name: str) -> bool:
    return Path(name).suffix.lower() in _IMAGE_EXT


def _items(folder_id: str) -> list[dict]:
    items: list[dict] = []
    offset = 0
    while True:
        batch = (
            _client()
            .get("/item", params={"folderId": folder_id, "limit": 500, "offset": offset})
            .raise_for_status()
            .json()
        )
        if not batch:
            break
        items.extend(batch)
        if len(batch) < 500:
            break
        offset += len(batch)
    return items


def _images(folder_id: str) -> list[dict]:
    cached = _images_cache.get(folder_id)
    if cached is None:
        cached = [it for it in _items(folder_id) if _is_image(it.get("name", ""))]
        _images_cache[folder_id] = cached
    return cached


def _kids(parent_type: str, parent_id: str) -> list[dict]:
    key = (parent_type, parent_id)
    cached = _kids_cache.get(key)
    if cached is None:
        cached = (
            _client()
            .get("/folder", params={"parentType": parent_type, "parentId": parent_id, "limit": 500})
            .raise_for_status()
            .json()
        )
        _kids_cache[key] = cached
    return cached


def _collect_images(folder_id: str, parent_type: str = "folder") -> list[dict]:
    out = list(_images(folder_id)) if parent_type == "folder" else []
    for child in _kids(parent_type, folder_id):
        out.extend(_collect_images(child["_id"]))
    return out


def _child_folders(parent_type: str, parent_id: str) -> list[dict]:
    out = []
    for f in _kids(parent_type, parent_id):
        d = _client().get(f"/folder/{f['_id']}/details").json()
        n_folders = int(d.get("nFolders") or 0)
        if n_folders:
            out.append({"id": f["_id"], "name": f["name"], "n_items": 0, "n_folders": n_folders})
            continue
        n_items = len(_images(f["_id"]))
        if n_items == 0:
            continue
        out.append({"id": f["_id"], "name": f["name"], "n_items": n_items, "n_folders": 0})
    return out


def _resource(parent_id: str) -> tuple[str, dict]:
    response = _client().get(f"/folder/{parent_id}")
    if response.status_code in {400, 404}:
        response = _client().get(f"/collection/{parent_id}")
        return "collection", response.raise_for_status().json()
    return "folder", response.raise_for_status().json()


def list_folders(parent_id: str | None = None) -> dict:
    empty = {"id": None, "name": "", "parent_id": None, "n_items": 0}
    if not girder_enabled() or parent_id == PLACEHOLDER_FOLDER:
        leaf = {
            "id": PLACEHOLDER_FOLDER,
            "name": "Placeholder",
            "parent_id": None,
            "n_items": 1,
            "children": [],
        }
        if parent_id == PLACEHOLDER_FOLDER:
            return leaf
        return {
            **empty,
            "children": [
                {"id": PLACEHOLDER_FOLDER, "name": "Placeholder", "n_items": 1, "n_folders": 0}
            ],
        }
    if not parent_id:
        children = []
        for col in _client().get("/collection", params={"limit": 100}).json():
            kids = _kids("collection", col["_id"])
            if not kids:
                continue
            children.append(
                {
                    "id": col["_id"],
                    "name": col["name"],
                    "n_items": 0,
                    "n_folders": len(kids),
                }
            )
        return {**empty, "children": children}
    parent_type, info = _resource(parent_id)
    return {
        "id": parent_id,
        "name": info["name"],
        "parent_id": info.get("parentId") if parent_type == "folder" else None,
        "n_items": len(_images(parent_id)) if parent_type == "folder" else 0,
        "children": _child_folders(parent_type, parent_id),
    }


def pick_region(folder_id: str | None) -> dict:
    if not girder_enabled() or not folder_id or folder_id == PLACEHOLDER_FOLDER:
        return _region(PLACEHOLDER_FOLDER, CROP_SIZE, CROP_SIZE)
    parent_type, _ = _resource(folder_id)
    images = _collect_images(folder_id, parent_type)
    random.shuffle(images)
    for item in images:
        info = _client().get(f"/item/{item['_id']}/tiles")
        if info.status_code != 200:
            continue
        data = info.json()
        if "sizeX" not in data or "sizeY" not in data:
            continue
        return _region(item["_id"], int(data["sizeX"]), int(data["sizeY"]))
    raise RuntimeError("no girder items in folder")


def fetch_image(item_id: str, left: int, top: int, width: int, height: int) -> bytes:
    if not girder_enabled() or item_id == PLACEHOLDER_FOLDER:
        return _placeholder(width, height)
    resp = _client().get(
        f"/item/{item_id}/tiles/region",
        params={
            "left": left,
            "top": top,
            "width": width,
            "height": height,
            "regionWidth": width,
            "regionHeight": height,
            "units": "base_pixels",
            "encoding": "PNG",
        },
    )
    resp.raise_for_status()
    return resp.content


def _placeholder(width: int, height: int) -> bytes:
    key = (width, height)
    cached = _placeholders.get(key)
    if cached:
        return cached
    img = Image.new("RGB", (width, height), (24, 24, 27))
    draw = ImageDraw.Draw(img)
    for i in range(0, width, 64):
        draw.line([(i, 0), (i, height)], fill=(39, 39, 42), width=1)
    for i in range(0, height, 64):
        draw.line([(0, i), (width, i)], fill=(39, 39, 42), width=1)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    _placeholders[key] = buf.getvalue()
    return _placeholders[key]
