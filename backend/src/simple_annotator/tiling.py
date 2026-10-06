import math

import cv2
import numpy as np

Rect = tuple[int, int, int, int]


def is_colored(rgb: np.ndarray) -> bool:
    # Tissue may fill only a sliver of the slide; grayscale stored as RGB has no chroma at all.
    chroma = rgb.max(axis=2).astype(np.int16) - rgb.min(axis=2)
    return float(np.mean(chroma >= 20)) >= 0.001


def tissue_mask(rgb: np.ndarray, um_per_px: float, min_area_um2: float) -> np.ndarray:
    rgb = np.ascontiguousarray(rgb)
    if is_colored(rgb):
        stain = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)[..., 1]
    else:
        # Gray stains show as darker than glass; black is padding beyond the scanned area.
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        stain = np.where(gray < 10, 0, 255 - gray).astype(np.uint8)
    stain = cv2.medianBlur(stain, 7)
    otsu, _ = cv2.threshold(stain, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Otsu splits noise on blank glass; such a faint signal is never stained tissue.
    _, mask = cv2.threshold(stain, max(otsu, 15), 255, cv2.THRESH_BINARY)
    size = max(3, round(500 / um_per_px) | 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask)
    keep = stats[:, cv2.CC_STAT_AREA] * um_per_px**2 >= min_area_um2
    keep[0] = False
    return keep[labels]


def _starts(size: int, tile: int, stride: int) -> list[int]:
    if size <= tile:
        return [0]
    return sorted({*range(0, size - tile, stride), size - tile})


def grid(width: int, height: int, tile: int, stride: int) -> list[Rect]:
    w, h = min(tile, width), min(tile, height)
    return [
        (x, y, w, h) for y in _starts(height, tile, stride) for x in _starts(width, tile, stride)
    ]


def _spans(start: int, end: int, max_size: int, overlap: int) -> list[tuple[int, int]]:
    length = end - start
    if length <= max_size:
        return [(start, length)]
    n = math.ceil((length - overlap) / (max_size - overlap))
    size = math.ceil((length + (n - 1) * overlap) / n)
    return [(start + round(i * (length - size) / (n - 1)), size) for i in range(n)]


def split(box: list[int], max_size: int, overlap: int) -> list[Rect]:
    xs = _spans(box[0], box[2], max_size, overlap)
    ys = _spans(box[1], box[3], max_size, overlap)
    return [(x, y, w, h) for y, h in ys for x, w in xs]


def tissue_regions(
    mask: np.ndarray, scale: float, width: int, height: int, merge: int, pad: int
) -> list[list[int]]:
    # merge is in mask pixels; pad and the returned boxes are in slide pixels.
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (merge | 1, merge | 1))
    closed = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_CLOSE, kernel)
    _, _, stats, _ = cv2.connectedComponentsWithStats(closed)
    boxes = [
        [
            max(0, int(x / scale) - pad),
            max(0, int(y / scale) - pad),
            min(width, math.ceil((x + w) / scale) + pad),
            min(height, math.ceil((y + h) / scale) + pad),
        ]
        for x, y, w, h, _ in stats[1:]
    ]
    # Separate tissue keeps its own box even where padding overlaps; only nested boxes go.
    kept: list[list[int]] = []
    for b in sorted(boxes, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]), reverse=True):
        if not any(k[0] <= b[0] and k[1] <= b[1] and b[2] <= k[2] and b[3] <= k[3] for k in kept):
            kept.append(b)
    return sorted(kept, key=lambda b: (b[1], b[0]))
