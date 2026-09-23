import io
import math
import os
from collections import OrderedDict
from pathlib import Path

import cv2
import httpx
import numpy as np
import torch
import xxhash
from PIL import Image
from segment_anything import SamPredictor, sam_model_registry

from simple_annotator.girder import fetch_image

MODEL_URL = (
    "https://uk1s3.embassy.ebi.ac.uk/public-datasets/bioimage.io/noisy-ox/1.2/files/vit_b.pt"
)
MODEL_HASH = "f3bf2ed83d691456bae2c3f9a05fb438"


def crop_box(request: dict, factor: int = 1) -> tuple[int, int, int, int]:
    scale = request.get("nm_per_px")
    side = (
        request["crop_nm"] / scale
        if scale and math.isfinite(scale) and scale > 0
        else request["crop_px"]
    )
    side = min(2048, max(128, math.ceil(side / 64) * 64)) * factor
    step = side // 2

    def axis(point, size):
        length = min(side, size)
        origin = round((point - length / 2) / step) * step
        return max(0, min(size - length, origin)), length

    x, w = axis(request["x"], request["width"])
    y, h = axis(request["y"], request["height"])
    return x, y, w, h


def checkpoint() -> Path:
    folder = Path(
        os.environ.get("SIMPLE_ANNOTATOR_MODEL_DIR", str(Path.home() / ".cache/simple-annotator"))
    )
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "microsam-em-1.2.pt"
    if path.exists():
        return path
    temporary = path.with_suffix(".download")
    digest = xxhash.xxh128()
    with httpx.stream("GET", MODEL_URL, follow_redirects=True, timeout=120) as response:
        response.raise_for_status()
        with temporary.open("wb") as f:
            for block in response.iter_bytes():
                f.write(block)
                digest.update(block)
    if digest.hexdigest() != MODEL_HASH:
        temporary.unlink()
        raise ValueError("Model checkpoint checksum mismatch")
    temporary.replace(path)
    return path


class MicroSam:
    def __init__(self):
        torch.set_num_threads(2)
        device = os.environ.get("SIMPLE_ANNOTATOR_AI_DEVICE", "cuda")
        if device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("CUDA is unavailable; check GPU access")
        self.model = sam_model_registry["vit_b"](checkpoint=str(checkpoint())).to(device).eval()
        self.predictor = SamPredictor(self.model)
        self.cache = OrderedDict()
        with torch.inference_mode():
            self.predictor.set_image(np.zeros((512, 512, 3), dtype=np.uint8))

    @torch.inference_mode()
    def predict(self, request: dict) -> dict:
        for factor in (1, 2, 4):
            x, y, w, h = crop_box(request, factor)
            key = (request["item_id"], request["left"] + x, request["top"] + y, w, h)
            state = self.cache.pop(key, None)
            if state is None:
                data = fetch_image(*key)
                pixels = np.asarray(Image.open(io.BytesIO(data)).convert("RGB"))
                self.predictor.set_image(pixels)
                state = (
                    self.predictor.features,
                    self.predictor.input_size,
                    self.predictor.original_size,
                )
            self.cache[key] = state
            if len(self.cache) > 16:
                self.cache.popitem(last=False)
            self.predictor.features, self.predictor.input_size, self.predictor.original_size = state
            self.predictor.is_image_set = True
            point = np.array([[request["x"] - x, request["y"] - y]])
            masks, scores, _ = self.predictor.predict(
                point_coords=point, point_labels=np.array([1]), multimask_output=True
            )
            px, py = min(w - 1, round(point[0, 0])), min(h - 1, round(point[0, 1]))
            choices = [i for i in np.argsort(scores)[::-1] if masks[i, py, px]]
            if not choices:
                raise ValueError(
                    "No structure found at this point. Try a nearby point or the brush."
                )
            _, labels = cv2.connectedComponents(masks[choices[0]].astype(np.uint8))
            mask = (labels == labels[py, px]).astype(np.uint8)
            clipped = (
                (x > 0 and mask[:, 0].any())
                or (y > 0 and mask[0, :].any())
                or (x + w < request["width"] and mask[:, -1].any())
                or (y + h < request["height"] and mask[-1, :].any())
            )
            if not clipped:
                break
        if clipped:
            raise ValueError(
                "Structure extends beyond the crop. Try another point or use the brush."
            )
        contours, hierarchy = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
        if hierarchy is None:
            raise ValueError("No outline found. Try another point.")
        rings = []
        for contour in contours:
            ring = cv2.approxPolyDP(contour, 0.5, True).reshape(-1, 2)
            rings.append((ring + [x, y]).tolist() if len(ring) >= 3 else [])
        outer = next((i for i, info in enumerate(hierarchy[0]) if info[3] < 0 and rings[i]), None)
        if outer is None:
            raise ValueError("Structure is too small to outline.")
        return {
            "points": rings[outer],
            "holes": [
                rings[i] for i, info in enumerate(hierarchy[0]) if info[3] == outer and rings[i]
            ],
        }
