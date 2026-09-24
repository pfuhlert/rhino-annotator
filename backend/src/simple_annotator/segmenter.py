import io
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

from simple_annotator.config import AI_MODEL, AI_MODEL_HASH
from simple_annotator.embeddings import (
    embedding_id,
    load_embedding,
    prompt_regions,
    save_embedding,
    tile_request,
)
from simple_annotator.girder import fetch_image

MODEL_URL = (
    "https://uk1s3.embassy.ebi.ac.uk/public-datasets/bioimage.io/noisy-ox/1.2/files/vit_b.pt"
)


def checkpoint() -> Path:
    folder = Path(
        os.environ.get("SIMPLE_ANNOTATOR_MODEL_DIR", str(Path.home() / ".cache/simple-annotator"))
    )
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{AI_MODEL}.pt"
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
    if digest.hexdigest() != AI_MODEL_HASH:
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
    def prepare(self, request: dict) -> tuple:
        key = embedding_id(request)
        state = self.cache.pop(key, None)
        if state is None:
            data = load_embedding(key)
            if data is not None:
                with np.load(io.BytesIO(data), allow_pickle=False) as saved:
                    state = (
                        torch.from_numpy(saved["features"]).to(self.predictor.device),
                        tuple(saved["input_size"].tolist()),
                        tuple(saved["original_size"].tolist()),
                    )
            else:
                data = fetch_image(
                    request["item_id"],
                    request["left"],
                    request["top"],
                    request["width"],
                    request["height"],
                )
                pixels = np.asarray(Image.open(io.BytesIO(data)).convert("RGB"))
                if pixels.shape[:2] != (request["height"], request["width"]):
                    raise ValueError("Image dimensions changed. Reopen the image before using AI.")
                self.predictor.set_image(pixels)
                state = (
                    self.predictor.features,
                    self.predictor.input_size,
                    self.predictor.original_size,
                )
                output = io.BytesIO()
                np.savez(
                    output,
                    features=state[0].detach().cpu().numpy(),
                    input_size=state[1],
                    original_size=state[2],
                )
                save_embedding(request, output.getvalue())
        self.cache[key] = state
        if len(self.cache) > 16:
            self.cache.popitem(last=False)
        return state

    @torch.inference_mode()
    def predict(self, request: dict) -> dict:
        mask, origin = (
            self._predict_box(request) if "box" in request else self._predict_point(request)
        )
        return mask_polygon(mask, origin)

    def _set_tile(self, request: dict, region: tuple[int, int, int, int]) -> None:
        state = self.prepare(tile_request(request, region))
        self.predictor.features, self.predictor.input_size, self.predictor.original_size = state
        self.predictor.is_image_set = True

    def _predict_box(self, request: dict) -> tuple[np.ndarray, tuple[int, int]]:
        region = prompt_regions(request)[0]
        x, y, _, _ = region
        self._set_tile(request, region)
        x0, y0, x1, y1 = np.array(request["box"]) - [x, y, x, y]
        masks, _, _ = self.predictor.predict(box=np.array([x0, y0, x1, y1]), multimask_output=False)
        # The model sees surrounding context, but the saved object stays inside the box.
        masks[0, :y0] = False
        masks[0, y1:] = False
        masks[0, :, :x0] = False
        masks[0, :, x1:] = False
        count, labels, stats, _ = cv2.connectedComponentsWithStats(masks[0].astype(np.uint8))
        if count < 2:
            raise ValueError("No structure found in this box. Try a tighter box or the brush.")
        largest = 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])
        return (labels == largest).astype(np.uint8), (x, y)

    def _predict_point(self, request: dict) -> tuple[np.ndarray, tuple[int, int]]:
        for x, y, w, h in prompt_regions(request):
            self._set_tile(request, (x, y, w, h))
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
                return mask, (x, y)
        raise ValueError("Structure extends beyond the tile. Try a box or use the brush.")


def mask_polygon(mask: np.ndarray, origin: tuple[int, int]) -> dict:
    contours, hierarchy = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None:
        raise ValueError("No outline found. Try another box or point.")
    rings = []
    for contour in contours:
        ring = cv2.approxPolyDP(contour, 0.5, True).reshape(-1, 2)
        rings.append((ring + origin).tolist() if len(ring) >= 3 else [])
    outer = next((i for i, info in enumerate(hierarchy[0]) if info[3] < 0 and rings[i]), None)
    if outer is None:
        raise ValueError("Structure is too small to outline.")
    return {
        "points": rings[outer],
        "holes": [rings[i] for i, info in enumerate(hierarchy[0]) if info[3] == outer and rings[i]],
    }
