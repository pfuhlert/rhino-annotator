import assert from "node:assert/strict";
import test from "node:test";
import { applyPolys, createBrush, jobPolys, type BrushPoly } from "../src/lib/brush";
import { type Mark } from "../src/lib/draw";
import { pointInPoly } from "../src/lib/geometry";

type Point = [number, number];
const square = (x: number, y: number, size: number): BrushPoly => ({
  points: [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
  ],
});
const contains = (polys: BrushPoly[], point: Point) =>
  polys.some(
    (p) => pointInPoly(point, p.points) && !(p.holes ?? []).some((h) => pointInPoly(point, h)),
  );
const distance = (p: Point, a: Point, b: Point) => {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const t =
    dx || dy
      ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)))
      : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};

function distanceToPath(point: Point, path: Point[]) {
  let nearest = distance(point, path[0], path[0]);
  for (let i = 1; i < path.length; i++)
    nearest = Math.min(nearest, distance(point, path[i - 1], path[i]));
  return nearest;
}

function assertBoundary(ring: Point[], path: Point[], radius: number) {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i],
      b = ring[(i + 1) % ring.length];
    for (const t of [0, 0.25, 0.5, 0.75]) {
      const point: Point = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      const error = Math.abs(distanceToPath(point, path) - radius);
      assert.ok(error <= 1.000001, `boundary error ${error}, radius ${radius}`);
    }
  }
}

test("dots and round strokes stay within one pixel at small and large brush sizes", () => {
  for (const radius of [2, 8, 16, 80]) {
    for (const points of [
      [[200, 200]],
      [
        [150, 150],
        [350, 280],
      ],
    ] as Point[][]) {
      const brush = createBrush(512, 512);
      brush.stamp(points, radius, false);
      const polys = brush.toPolygons();
      assert.equal(polys.length, 1);
      assertBoundary(polys[0].points, points, radius);
    }
  }
});

test("erasing creates a hole; painting can add an island and fill the hole", () => {
  const brush = createBrush(200, 200);
  brush.enter([square(20, 20, 160)]);
  brush.stamp([[100, 100]], 20, true);
  const donut = brush.toPolygons();
  assert.equal(donut.length, 1);
  assert.equal(donut[0].holes?.length, 1);
  assert.equal(contains(donut, [100, 100]), false);
  brush.stamp([[100, 100]], 4, false);
  const island = brush.toPolygons();
  assert.equal(island.length, 2);
  assert.equal(contains(island, [100, 100]), true);
  assert.equal(contains(island, [110, 100]), false);
  brush.stamp([[100, 100]], 24, false);
  const filled = brush.toPolygons();
  assert.equal(filled.length, 1);
  assert.equal(filled[0].holes, undefined);
});

test("strokes merge islands and erasing can split a polygon", () => {
  const brush = createBrush(200, 200);
  brush.enter([square(20, 20, 40), square(100, 20, 40)]);
  brush.stamp(
    [
      [50, 40],
      [110, 40],
    ],
    6,
    false,
  );
  assert.equal(brush.toPolygons().length, 1);
  brush.stamp(
    [
      [80, 0],
      [80, 100],
    ],
    5,
    true,
  );
  const split = brush.toPolygons();
  assert.equal(split.length, 2);
  assert.equal(contains(split, [80, 40]), false);
  assert.equal(contains(split, [40, 40]), true);
  assert.equal(contains(split, [120, 40]), true);
});

test("a local edit preserves distant geometry to floating-point precision and keeps a one-pixel hole", () => {
  const points = Array.from({ length: 200 }, (_, i): Point => {
    const a = (i * Math.PI * 2) / 200;
    return [512 + 300 * Math.cos(a), 512 + 300 * Math.sin(a)];
  });
  const original = { points, holes: [square(500.25, 500.25, 1).points] };
  const saved = structuredClone(original);
  const brush = createBrush(1024, 1024);
  brush.enter([original]);
  brush.stamp([[560, 217]], 18, false);
  const result = brush.toPolygons();
  assert.equal(result.length, 1);
  for (const p of points.filter((p) => Math.hypot(p[0] - 560, p[1] - 217) > 20)) {
    assert.ok(
      result[0].points.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-9),
      `lost distant vertex ${p}`,
    );
  }
  assert.equal(result[0].holes?.length, 1);
  for (const p of original.holes[0])
    assert.ok(result[0].holes![0].some((q) => q[0] === p[0] && q[1] === p[1]));
  assert.deepEqual(original, saved);
});

test("erasing a hole or splitting a polygon keeps the original id on one piece", () => {
  const mark: Mark = { ...square(0, 0, 100), id: "keep", type: "polygon", jobId: 1 };
  const brush = createBrush(200, 200);
  brush.enter([mark]);
  brush.stamp([[50, 50]], 10, true);
  const holed = applyPolys([mark], 1, brush.toPolygons());
  assert.deepEqual(
    holed.map((m) => [m.id, m.holes?.length]),
    [["keep", 1]],
  );
  brush.stamp(
    [
      [50, -10],
      [50, 110],
    ],
    5,
    true,
  );
  const split = applyPolys(holed, 1, brush.toPolygons());
  assert.equal(split.length, 2);
  assert.equal(split.filter((m) => m.id === "keep").length, 1);
});

test("unaffected annotations retain their coordinates, identity, and job", () => {
  const near: Mark = { ...square(10, 10, 30), id: "near", type: "polygon", jobId: 1 };
  const far: Mark = { ...square(100, 100, 30), id: "far", type: "polygon", jobId: 1 };
  const other: Mark = { ...square(10, 10, 30), id: "other", type: "polygon", jobId: 2 };
  const point: Mark = { id: "point", type: "point", points: [[20, 20]], jobId: 1 };
  const marks = [near, far, other, point];
  const brush = createBrush(200, 200);
  brush.enter(jobPolys(marks, 1));
  brush.stamp([[40, 20]], 5, false);
  const next = applyPolys(marks, 1, brush.toPolygons());
  for (const m of [far, other, point])
    assert.equal(
      next.find((n) => n.id === m.id),
      m,
    );
  const edited = next.find((n) => n.id === "near");
  assert.ok(edited && edited !== near, "an edited polygon keeps its id");
  const entered = jobPolys(next, 1);
  brush.enter(entered);
  assert.equal(brush.toPolygons(), entered);
});

test("operations stay inside the image and apply pending paint/erase in order", () => {
  const brush = createBrush(100, 100);
  brush.stamp([[-30, -30]], 5, false);
  assert.deepEqual(brush.toPolygons(), []);
  brush.stamp(
    [
      [0, 0],
      [100, 100],
    ],
    10,
    false,
  );
  brush.stamp([[50, 50]], 20, true);
  brush.stamp([[50, 50]], 3, false);
  const result = brush.toPolygons();
  assert.equal(contains(result, [50, 50]), true);
  assert.equal(contains(result, [60, 60]), false);
  for (const p of result)
    for (const ring of [p.points, ...(p.holes ?? [])])
      for (const [x, y] of ring) {
        assert.ok(x >= 0 && x <= 100 && y >= 0 && y <= 100);
      }
  assert.equal(brush.toPolygons(), result);
  brush.enter([square(20, 20, 30)]);
  brush.stamp([[50, 50]], 200, true);
  assert.deepEqual(brush.toPolygons(), []);
});

test("batching pointer samples does not skip segments or change the stroke", () => {
  const points: Point[] = [
    [20, 20],
    [80, 20],
    [80, 80],
    [20, 80],
    [40, 40],
  ];
  const batch = createBrush(100, 100),
    incremental = createBrush(100, 100);
  for (const brush of [batch, incremental]) brush.stamp([points[0]], 3, false);
  batch.stamp(points, 3, false);
  for (let i = 1; i < points.length; i++) incremental.stamp(points.slice(i - 1, i + 1), 3, false);
  const result = batch.toPolygons();
  assert.deepEqual(incremental.toPolygons(), result);
  for (const p of points) assert.equal(contains(result, p), true);
});

test("dense curves and shallow jitter stay compact without flattening sharp turns", () => {
  const curve = Array.from({ length: 1000 }, (_, i): Point => [
    100 + i * 0.3,
    200 + 20 * Math.sin(i / 100),
  ]);
  const corner = Array.from({ length: 501 }, (_, i): Point => [
    100 + i * 0.6,
    200 + 0.14 * Math.sin((i * Math.PI * 2) / 20),
  ]);
  corner.push([400, 320]);
  for (const [path, radius, limit] of [
    [curve, 8, 200],
    [corner, 16, 60],
  ] as const) {
    const brush = createBrush(512, 512);
    brush.stamp(path, radius, false);
    const result = brush.toPolygons();
    assert.equal(result.length, 1);
    assert.ok(result[0].points.length < limit, "redundant samples should not become vertices");
    assertBoundary(result[0].points, path, radius);
    if (path === corner) {
      assert.ok(contains(result, [400, 200]), "keep the sharp corner");
      assert.equal(contains(result, [380, 220]), false);
    }
  }
});

test("retracing a stroke with the eraser does not crash on coincident curved segments", () => {
  const points: Point[] = [
    [939.5527033917788, 1053.2518164239893],
    [940.3457839545044, 1054.2165069511695],
    [943.539917775448, 1060.4378717657248],
    [948.2775645787078, 1060.5240874594613],
  ];
  const brush = createBrush(2048, 2048);
  const distant = square(100, 100, 20);
  brush.enter([distant]);
  brush.stamp(points, 67, false);
  const painted = brush.toPolygons();
  assert.ok(contains(painted, points[0]));
  brush.stamp(points, 67, true);
  assert.deepEqual(brush.toPolygons(), [distant]);
  assert.equal(brush.toPolygons()[0], distant);
  brush.stamp([[950, 1055]], 4, false);
  assert.ok(contains(brush.toPolygons(), [950, 1055]));
});

test("repeated overlapping local dabs keep vertex growth bounded", () => {
  const brush = createBrush(512, 512);
  brush.enter([square(50, 50, 400)]);
  for (let cycle = 0; cycle < 10; cycle++) {
    for (let i = 0; i < 20; i++) {
      brush.stamp([[50 + i * 4, 50 + 4 * Math.sin(i)]], 8, false);
      const result = brush.toPolygons();
      assert.equal(result.length, 1);
      assert.ok(result[0].points.length < 80, "repainting should not accumulate subdivisions");
    }
  }
});

test("closed, crossing, and reversing strokes match round-brush coverage", () => {
  const [a, b, c, d] = square(80, 80, 80).points;
  for (const path of [
    [a, b, c, d, a],
    [a, c, d, b, a, [120, 82], a],
  ] as Point[][]) {
    for (const radius of [3, 16, 47]) {
      const brush = createBrush(256, 256);
      brush.stamp(path, radius, false);
      const result = brush.toPolygons();
      for (let x = 20; x < 220; x += 4) {
        for (let y = 20; y < 220; y += 4) {
          const point: Point = [x, y];
          const nearest = distanceToPath(point, path);
          if (Math.abs(nearest - radius) > 1.000001)
            assert.equal(
              contains(result, point),
              nearest < radius,
              `coverage at ${point}, radius ${radius}`,
            );
        }
      }
    }
  }
});

test("local paint and erase preserve the even-odd fill of a self-crossing source polygon", () => {
  const tips = Array.from({ length: 5 }, (_, i): Point => {
    const angle = -Math.PI / 2 + (i * Math.PI * 2) / 5;
    return [100 + 70 * Math.cos(angle), 100 + 70 * Math.sin(angle)];
  });
  const star = { points: [tips[0], tips[2], tips[4], tips[1], tips[3]] };
  for (const erase of [false, true]) {
    const brush = createBrush(200, 200);
    brush.enter([star]);
    brush.stamp([[100, 30]], 2, erase);
    const result = brush.toPolygons();
    assert.equal(contains(result, [100, 100]), false, "keep the distant center empty");
    for (let x = 10.37; x < 190; x += 10)
      for (let y = 10.61; y < 190; y += 10)
        if (Math.hypot(x - 100, y - 30) > 3)
          assert.equal(contains(result, [x, y]), contains([star], [x, y]), `fill at ${x},${y}`);
  }
});

test("source polygons normalize separately so overlapping annotations stay filled", () => {
  const donut = { ...square(20, 20, 100), holes: [square(50, 50, 20).points.reverse()] };
  const overlap = square(60, 20, 100);
  overlap.points.reverse();
  const brush = createBrush(200, 200);
  brush.enter([donut, overlap]);
  brush.stamp([[90, 20]], 2, false);
  const result = brush.toPolygons();
  assert.equal(result.length, 1);
  assert.equal(contains(result, [90, 90]), true, "overlapping outer rings must not cancel");
  assert.equal(contains(result, [55, 60]), false, "keep the uncovered part of the hole");
  assert.equal(
    contains(result, [65, 60]),
    true,
    "the other polygon fills its overlap with the hole",
  );
});

test("local edits reuse distant bounds and enter refreshes bounds after manual edits", () => {
  let visited = 0;
  const far: BrushPoly = {
    points: new Proxy(square(400, 400, 20).points, {
      get(target, key, receiver) {
        if (key === Symbol.iterator)
          return function* () {
            visited++;
            yield* target;
          };
        return Reflect.get(target, key, receiver);
      },
    }),
  };
  const brush = createBrush(512, 512);
  brush.enter([far]);
  visited = 0;
  for (const erase of [false, true]) {
    brush.stamp([[20, 20]], 2, erase);
    brush.toPolygons();
  }
  assert.equal(visited, 0, "an unrelated edit should not traverse distant vertices");
  assert.equal(brush.toPolygons()[0], far);
  far.points = square(10, 10, 20).points;
  brush.enter([far]);
  brush.stamp([[20, 20]], 2, true);
  const result = brush.toPolygons();
  assert.equal(result.length, 1);
  assert.equal(result[0].holes?.length, 1, "refresh cached bounds when geometry is re-entered");
});
