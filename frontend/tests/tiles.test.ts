import assert from "node:assert/strict";
import test from "node:test";
import type { PatchImage } from "../src/lib/api";
import { downsample, evict, pickLevel, visibleTiles } from "../src/lib/tiles";

const image: PatchImage = {
  width: 3000,
  height: 1000,
  left: 1000,
  top: 300,
  slide_width: 5000,
  slide_height: 2000,
  tile_width: 256,
  tile_height: 256,
  levels: 6,
  tile_url: "/t/{z}/{x}/{y}",
  prepare_view: false,
};

test("level keeps at least one tile pixel per device pixel", () => {
  assert.equal(pickLevel(2, 6), 5);
  assert.equal(pickLevel(1, 6), 5);
  assert.equal(pickLevel(0.6, 6), 5);
  assert.equal(pickLevel(0.4, 6), 4);
  assert.equal(pickLevel(0.01, 6), 0);
});

test("visible tiles cover an unaligned view without gaps", () => {
  const view = { left: 37, top: 11, width: 2900, height: 980 };
  for (const z of [2, 4, 5]) {
    const span = 256 * downsample(image, z);
    const tiles = visibleTiles(image, z, view);
    const covered = (x: number, y: number) =>
      tiles.some(
        (t) => t.x * span <= x && x < (t.x + 1) * span && t.y * span <= y && y < (t.y + 1) * span,
      );
    for (let x = image.left + view.left; x < image.left + view.left + view.width; x += 97) {
      for (let y = image.top + view.top; y < image.top + view.top + view.height; y += 53) {
        assert.ok(covered(x, y), `z=${z} misses ${x},${y}`);
      }
    }
    assert.ok(
      tiles.every((t) => t.x * span < image.slide_width && t.y * span < image.slide_height),
    );
  }
});

test("eviction keeps every tile the view still needs", () => {
  const cache = new Map([1, 2, 3, 4, 5, 6].map((key) => [key, key]));
  evict(cache, new Set([1, 2, 3, 4, 5]), 3);
  assert.deepEqual([...cache.keys()], [1, 2, 3, 4, 5]);
  evict(cache, new Set([5]), 3);
  assert.deepEqual([...cache.keys()], [3, 4, 5]);
});
