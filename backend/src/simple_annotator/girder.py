import io
import random

import httpx
from PIL import Image, ImageDraw

from simple_annotator.config import (
    CROP_SIZE,
    FULL_IMAGE_MAX,
    GIRDER_API_URL,
    GIRDER_FOLDER_ID,
    GIRDER_TOKEN,
)

_gc: httpx.Client | None = None
_placeholders: dict[tuple[int, int], bytes] = {}


def girder_enabled() -> bool:
    return bool(GIRDER_TOKEN and GIRDER_FOLDER_ID)


def _client() -> httpx.Client:
    global _gc
    if _gc is None:
        _gc = httpx.Client(base_url=GIRDER_API_URL.rstrip("/"), timeout=30)
        me = _gc.get("/user/me", headers={"Girder-Token": GIRDER_TOKEN})
        token = GIRDER_TOKEN
        if not (me.status_code == 200 and me.json()):
            r = _gc.post("/api_key/token", data={"key": GIRDER_TOKEN})
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


def pick_region() -> dict:
    if not girder_enabled():
        return _region("placeholder", CROP_SIZE, CROP_SIZE)
    items = _client().get("/item", params={"folderId": GIRDER_FOLDER_ID, "limit": 100}).json()
    if not items:
        raise RuntimeError("no girder items in folder")
    item = random.choice(items)
    info = _client().get(f"/item/{item['_id']}/tiles").json()
    return _region(item["_id"], int(info["sizeX"]), int(info["sizeY"]))


def fetch_image(item_id: str, left: int, top: int, width: int, height: int) -> bytes:
    if not girder_enabled() or item_id == "placeholder":
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
