import cv2
import numpy as np
import pytest

from simple_annotator.tiling import grid, is_colored, split, tissue_mask, tissue_regions


def tissue_image(width=400, height=300, center=(100, 150), radius=60) -> np.ndarray:
    rgb = np.full((height, width, 3), 245, np.uint8)
    cv2.circle(rgb, center, radius, (200, 90, 160), -1)
    return rgb


@pytest.mark.parametrize("width,height", [(10_000, 7_300), (4_001, 9_999), (5_000, 5_000)])
def test_grid_stays_inside_and_contains_every_overlap_sized_object(width, height):
    tile, overlap = 4000, 1200
    tiles = grid(width, height, tile, tile - overlap)
    assert all(x >= 0 and y >= 0 and x + w <= width and y + h <= height for x, y, w, h in tiles)
    for size, starts in ((width, {x for x, *_ in tiles}), (height, {y for _, y, *_ in tiles})):
        for pos in range(0, size - overlap + 1, 97):
            assert any(s <= pos and pos + overlap <= s + tile for s in starts)


def test_small_image_is_one_whole_tile():
    assert grid(900, 700, 4000, 2800) == [(0, 0, 900, 700)]


def test_regions_pad_tissue_and_merge_only_nearby_fragments():
    rgb = tissue_image(center=(100, 150), radius=40)
    cv2.circle(rgb, (190, 150), 40, (200, 90, 160), -1)  # 10 px gap to the first blob
    cv2.circle(rgb, (340, 150), 30, (200, 90, 160), -1)
    mask = tissue_mask(rgb, um_per_px=2.5, min_area_um2=10_000)
    # Mask pixels are 10 slide pixels; pad by 100 slide pixels.
    regions = tissue_regions(mask, 0.1, 4000, 3000, merge=20, pad=100)
    assert len(regions) == 2
    for box, (lo, hi) in zip(sorted(regions), [(0, 260), (260, 400)]):
        xs = np.nonzero(mask[:, lo:hi])[1] + lo
        assert box[2] - box[0] >= (xs.max() + 1 - xs.min()) * 10 + 2 * 100
    for y, x in zip(*np.nonzero(mask)):
        assert any(b[0] <= x * 10 < b[2] and b[1] <= y * 10 < b[3] for b in regions)


def test_oversized_regions_split_into_overlapping_chunks():
    chunks = split([500, 0, 23_000, 3_000], max_size=20_000, overlap=1_200)
    assert [(c[1], c[3]) for c in chunks] == [(0, 3_000)] * 2
    (x0, _, w0, _), (x1, _, w1, _) = chunks
    assert x0 == 500 and x1 + w1 == 23_000
    assert max(w0, w1) <= 20_000 and x0 + w0 - x1 >= 1_200
    assert split([0, 0, 900, 700], 20_000, 1_200) == [(0, 0, 900, 700)]


def test_specks_and_blank_glass_are_not_tissue():
    rgb = tissue_image(radius=2)
    assert not tissue_mask(rgb, um_per_px=2.5, min_area_um2=10_000).any()
    blank = np.full((300, 400, 3), 245, np.uint8)
    assert not tissue_mask(blank, um_per_px=2.5, min_area_um2=10_000).any()


def test_colored_detection_ignores_grayscale_stored_as_rgb():
    assert is_colored(tissue_image())
    gray = cv2.cvtColor(tissue_image(), cv2.COLOR_RGB2GRAY)
    assert not is_colored(np.repeat(gray[..., None], 3, axis=2))
