import argparse
import io
import json
import math
import random
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from PIL import Image, ImageDraw

parser = argparse.ArgumentParser()
parser.add_argument("image")
parser.add_argument("--port", type=int, default=8199)
parser.add_argument("--nm-per-px", type=float, default=1.220703125)
args = parser.parse_args()
image = Image.open(args.image).convert("RGB")


# A 7.5 x 3 mm slide at 250 nm/px: one tissue strip wider than the 5 mm region limit (split in
# two) and one small fragment. It is drawn on demand, so any level or window stays cheap.
SLIDE_WIDTH, SLIDE_HEIGHT = 30000, 12000
TILE = 256
BLOBS = [(11000, 5500, 10500, 3000), (26500, 4000, 1500, 1200)]


def _shapes() -> list[tuple[float, float, float, float, tuple[int, int, int]]]:
    rng = random.Random(0)
    shapes = []
    for x, y, rx, ry in BLOBS:

        def spot(spread: float) -> tuple[float, float]:
            return (
                rng.uniform(x - rx * spread, x + rx * spread),
                rng.uniform(y - ry * spread, y + ry * spread),
            )

        shapes.append((x, y, rx, ry, (226, 160, 196)))
        for _ in range(int(rx * ry // 4000)):
            cx, cy = (
                rng.uniform(x - rx * 0.7, x + rx * 0.7),
                rng.uniform(y - ry * 0.7, y + ry * 0.7),
            )
            shapes.append((cx, cy, 6, 5, (92, 60, 150)))
        # Glomerulus-sized (190 µm) structures for AI Box checks.
        for _ in range(max(2, rx // 1000)):
            cx, cy = (
                rng.uniform(x - rx * 0.5, x + rx * 0.5),
                rng.uniform(y - ry * 0.5, y + ry * 0.5),
            )
            shapes.append((cx, cy, 380, 380, (196, 112, 170)))
    return shapes


SHAPES = _shapes()


def _render(item: str, x: float, y: float, w: float, h: float, out_w: int, out_h: int):
    if item == "tem":
        return image.crop((x, y, x + w, y + h)).resize((out_w, out_h), Image.LANCZOS)
    scale = out_w / w
    img = Image.new("RGB", (out_w, out_h), (244, 242, 246))
    draw = ImageDraw.Draw(img)
    for cx, cy, rx, ry, fill in SHAPES:
        if cx + rx < x or cx - rx > x + w or cy + ry < y or cy - ry > y + h or rx * scale < 0.3:
            continue
        box = (
            (cx - rx - x) * scale,
            (cy - ry - y) * scale,
            (cx + rx - x) * scale,
            (cy + ry - y) * scale,
        )
        draw.ellipse(box, fill=fill)
    return img


def _size(item: str) -> tuple[int, int]:
    return image.size if item == "tem" else (SLIDE_WIDTH, SLIDE_HEIGHT)


def _levels(item: str) -> int:
    return max(0, math.ceil(math.log2(max(_size(item)) / TILE))) + 1


def _encode(img: Image.Image, fmt: str) -> bytes:
    output = io.BytesIO()
    img.save(output, format=fmt)
    return output.getvalue()


thumbnails: dict[tuple[str, int, int], bytes] = {}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        path = url.path
        data = None
        if path == "/user/me":
            data = {"_id": "fixture"}
        elif path == "/collection":
            data = [{"_id": "fixtures", "name": "Verification images"}]
        elif path == "/folder":
            data = (
                [{"_id": "elmi", "name": "ELMI"}, {"_id": "histo", "name": "Histology"}]
                if query.get("parentId") == ["fixtures"]
                else []
            )
        elif path == "/collection/fixtures":
            data = {"_id": "fixtures", "name": "Verification images"}
        elif path == "/folder/elmi":
            data = {"_id": "elmi", "name": "ELMI", "parentId": "fixtures"}
        elif path == "/folder/histo":
            data = {"_id": "histo", "name": "Histology", "parentId": "fixtures"}
        elif path in {"/folder/elmi/details", "/folder/histo/details"}:
            data = {"nFolders": 0}
        elif path == "/item":
            data = (
                [{"_id": "slide", "name": "Synthetic H&E.svs", "folderId": "histo"}]
                if query.get("folderId") == ["histo"]
                else [{"_id": "tem", "name": "TEM.png", "folderId": "elmi"}]
            )
        elif path == "/item/tem":
            data = {"folderId": "elmi", "meta": {"nm_per_px": args.nm_per_px}}
        elif path == "/item/slide":
            data = {"folderId": "histo", "meta": {}}
        elif path in {"/item/tem/tiles", "/item/slide/tiles"}:
            item = path.split("/")[2]
            width, height = _size(item)
            data = {
                "sizeX": width,
                "sizeY": height,
                "tileWidth": TILE,
                "tileHeight": TILE,
                "levels": _levels(item),
            }
            if item == "slide":
                data |= {"mm_x": 0.00025, "mm_y": 0.00025}
        elif "/tiles/" in path:
            item = path.split("/")[2]
            width, height = _size(item)
            if path.endswith("/region"):
                x, y, w, h = (int(query[key][0]) for key in ("left", "top", "width", "height"))
                body, content_type = _encode(_render(item, x, y, w, h, w, h), "PNG"), "image/png"
            elif path.endswith("/thumbnail"):
                key = (item, int(query["width"][0]), int(query["height"][0]))
                if key not in thumbnails:
                    scale = min(key[1] / width, key[2] / height)
                    out = (round(width * scale), round(height * scale))
                    thumbnails[key] = _encode(_render(item, 0, 0, width, height, *out), "PNG")
                body, content_type = thumbnails[key], "image/png"
            else:
                z, tx, ty = (int(part) for part in path.split("/")[-3:])
                down = 2 ** (_levels(item) - 1 - z)
                x, y = tx * TILE * down, ty * TILE * down
                w, h = min(TILE * down, width - x), min(TILE * down, height - y)
                if w <= 0 or h <= 0:
                    self.send_error(404)
                    return
                out = (max(1, math.ceil(w / down)), max(1, math.ceil(h / down)))
                body = _encode(_render(item, x, y, w, h, *out), "JPEG")
                content_type = "image/jpeg"
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if data is None:
            self.send_error(404)
            return
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


print(f"Fixture image source ready on {args.port}", flush=True)
ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
