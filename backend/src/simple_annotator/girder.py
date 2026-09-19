import random

import httpx
from PIL import Image, ImageDraw, ImageFont

from simple_annotator.config import CROP_SIZE, GIRDER_API_URL, GIRDER_FOLDER_ID, GIRDER_TOKEN


def girder_enabled() -> bool:
    return bool(GIRDER_TOKEN and GIRDER_FOLDER_ID)


def _session_token() -> str:
    with httpx.Client(base_url=GIRDER_API_URL.rstrip("/"), timeout=30) as gc:
        me = gc.get("/user/me", headers={"Girder-Token": GIRDER_TOKEN})
        if me.status_code == 200 and me.json():
            return GIRDER_TOKEN
        r = gc.post("/api_key/token", data={"key": GIRDER_TOKEN})
        r.raise_for_status()
        return r.json()["authToken"]["token"]


def _client() -> httpx.Client:
    return httpx.Client(
        base_url=GIRDER_API_URL.rstrip("/"),
        headers={"Girder-Token": _session_token()},
        timeout=30,
    )


def pick_region() -> dict:
    if not girder_enabled():
        return {
            "girder_item_id": "placeholder",
            "left": random.randint(0, 4000),
            "top": random.randint(0, 4000),
            "width": CROP_SIZE,
            "height": CROP_SIZE,
        }
    with _client() as gc:
        items = gc.get("/item", params={"folderId": GIRDER_FOLDER_ID, "limit": 100}).json()
        if not items:
            raise RuntimeError("no girder items in folder")
        item = random.choice(items)
        info = gc.get(f"/item/{item['_id']}/tiles").json()
        w, h = int(info["sizeX"]), int(info["sizeY"])
        left = random.randint(0, max(0, w - CROP_SIZE))
        top = random.randint(0, max(0, h - CROP_SIZE))
        return {
            "girder_item_id": item["_id"],
            "left": left,
            "top": top,
            "width": min(CROP_SIZE, w),
            "height": min(CROP_SIZE, h),
        }


def fetch_image(item_id: str, left: int, top: int, width: int, height: int) -> bytes:
    if not girder_enabled() or item_id == "placeholder":
        return _placeholder(left, top, width, height)
    with _client() as gc:
        resp = gc.get(
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


def _placeholder(left: int, top: int, width: int, height: int) -> bytes:
    img = Image.new("RGB", (width, height), (24, 24, 27))
    draw = ImageDraw.Draw(img)
    for i in range(0, width, 64):
        draw.line([(i, 0), (i, height)], fill=(39, 39, 42), width=1)
    for i in range(0, height, 64):
        draw.line([(0, i), (width, i)], fill=(39, 39, 42), width=1)
    label = f"{left},{top}"
    font = ImageFont.load_default()
    draw.text((16, 16), label, fill=(244, 244, 245), font=font)
    buf = __import__("io").BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
