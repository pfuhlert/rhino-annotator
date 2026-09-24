import assert from "node:assert/strict";
import test from "node:test";
import { imagePoint, imageScreenRect, imageToScreen, type Mark, type Space } from "../src/lib/draw";
import {
  brushTouchesImage,
  clampToImage,
  imageBox,
  insideImageBounds,
  insidePixelBounds,
  moveWithinImage,
} from "../src/lib/image-bounds";

const size = { imageWidth: 400, imageHeight: 200 };

test("AI boxes use pixel-aligned bounds in either drag direction", () => {
  assert.deepEqual(imageBox([20.2, 30.8], [150.6, 100.1], size), [20, 31, 151, 100]);
  assert.deepEqual(imageBox([150.6, 100.1], [20.2, 30.8], size), [20, 31, 151, 100]);
  assert.deepEqual(imageBox([150.6, 30.8], [20.2, 100.1], size), [20, 31, 151, 100]);
});

test("AI boxes stop at image edges and reject clicks or degenerate drags", () => {
  assert.deepEqual(imageBox([50, 60], [800, 400], size), [50, 60, 400, 200]);
  assert.deepEqual(imageBox([50, 60], [-30, -40], size), [0, 0, 50, 60]);
  assert.equal(imageBox([20, 20], [20, 20], size), null);
  assert.equal(imageBox([20, 20], [21, 80], size), null);
  assert.equal(imageBox([20, 20], [80, 21], size), null);
});

test("drawing slides along all four image edges and clamps corners", () => {
  assert.deepEqual(
    [
      [-20, 30],
      [-20, 80],
      [40, -10],
      [80, -10],
      [450, 60],
      [80, 240],
      [-20, 240],
    ].map((p) => clampToImage(p as [number, number], size)),
    [
      [0, 30],
      [0, 80],
      [40, 0],
      [80, 0],
      [400, 60],
      [80, 200],
      [0, 200],
    ],
  );
  assert.deepEqual(clampToImage([70.5, 32.25], size), [70.5, 32.25]);
});

test("bounds follow image coordinates after zoom, pan and letterboxing", () => {
  const space: Space = {
    ...size,
    imgLeft: -160,
    imgTop: 40,
    ox: 30,
    oy: 60,
    scale: 2,
    rootLeft: 20,
    rootTop: 10,
  };
  const point = imagePoint({ clientX: -180, clientY: 180 }, space);
  assert.equal(insideImageBounds(point, space), false);
  assert.deepEqual(imageToScreen(clampToImage(point, space), space), [-150, 170]);
  assert.deepEqual(imageScreenRect(space), { left: -150, top: 90, right: 650, bottom: 490 });
});

test("point placement excludes the maximum image edges while polygons may touch them", () => {
  const edges: [number, number][] = [
    [400, 0],
    [0, 200],
    [400, 200],
  ];
  for (const point of edges) {
    assert.equal(insideImageBounds(point, size), true);
    assert.equal(insidePixelBounds(point, size), false);
  }
  assert.equal(insidePixelBounds([0, 0], size), true);
  assert.equal(insidePixelBounds([399.5, 199.5], size), true);
  assert.equal(insidePixelBounds([-0.1, 20], size), false);
  assert.equal(insideImageBounds([20, 200.1], size), false);
});

test("brushes can overlap an edge but cannot start fully outside, including diagonally", () => {
  assert.equal(brushTouchesImage([-9, 100], 10, size), true);
  assert.equal(brushTouchesImage([-10, 100], 10, size), false);
  assert.equal(brushTouchesImage([405, 205], 10, size), true);
  assert.equal(brushTouchesImage([408, 208], 10, size), false);
});

test("whole-polygon movement stops at the boundary without distorting its outline or holes", () => {
  const mark: Mark = {
    id: "shape",
    jobId: 1,
    type: "polygon",
    points: [
      [20, 30],
      [100, 30],
      [100, 90],
      [20, 90],
    ],
    holes: [
      [
        [40, 40],
        [60, 40],
        [50, 60],
      ],
    ],
  };
  const original = structuredClone(mark);
  assert.deepEqual(moveWithinImage(mark, 500, -80, size), [300, -30]);
  assert.deepEqual(
    mark.points,
    original.points.map(([x, y]) => [x + 300, y - 30]),
  );
  assert.deepEqual(
    mark.holes,
    original.holes!.map((ring) => ring.map(([x, y]) => [x + 300, y - 30])),
  );
  assert.equal(moveWithinImage(mark, 5, -5, size), null);
  assert.deepEqual(moveWithinImage(mark, -10, 10, size), [-10, 10]);
  assert.deepEqual(moveWithinImage(mark, -1000, 1000, size), [-310, 130]);
  assert.deepEqual(mark.points, [
    [0, 140],
    [80, 140],
    [80, 200],
    [0, 200],
  ]);
});

test("point dragging is bounded too", () => {
  const mark: Mark = { id: "point", jobId: 1, type: "point", points: [[40, 30]] };
  moveWithinImage(mark, -90, 500, size);
  assert.deepEqual(mark.points, [[0, 199]]);
  assert.equal(insidePixelBounds(mark.points[0], size), true);
  moveWithinImage(mark, 1000, 1000, size);
  assert.deepEqual(mark.points, [[399, 199]]);
  assert.equal(insidePixelBounds(mark.points[0], size), true);
  assert.equal(moveWithinImage(mark, 10, 10, size), null);
  moveWithinImage(mark, -1000, -1000, size);
  assert.deepEqual(mark.points, [[0, 0]]);
});
