import argparse
import io
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument("image")
parser.add_argument("--port", type=int, default=8199)
parser.add_argument("--nm-per-px", type=float, default=1.220703125)
args = parser.parse_args()
image = Image.open(args.image).convert("RGB")


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
                [{"_id": "elmi", "name": "ELMI"}] if query.get("parentId") == ["fixtures"] else []
            )
        elif path == "/collection/fixtures":
            data = {"_id": "fixtures", "name": "Verification images"}
        elif path == "/folder/elmi":
            data = {"_id": "elmi", "name": "ELMI", "parentId": "fixtures"}
        elif path == "/folder/elmi/details":
            data = {"nFolders": 0}
        elif path == "/item":
            data = [{"_id": "tem", "name": "TEM.png"}]
        elif path == "/item/tem":
            data = {"folderId": "elmi", "meta": {"nm_per_px": args.nm_per_px}}
        elif path == "/item/tem/tiles":
            data = {"sizeX": image.width, "sizeY": image.height}
        elif path == "/item/tem/tiles/region":
            x, y, w, h = (int(query[key][0]) for key in ("left", "top", "width", "height"))
            output = io.BytesIO()
            image.crop((x, y, x + w, y + h)).save(output, format="PNG")
            body = output.getvalue()
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
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
