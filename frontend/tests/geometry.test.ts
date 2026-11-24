import assert from "node:assert/strict";
import test from "node:test";
import { hasPolygonArea, hitAnyMark, measurePolygon } from "../src/lib/geometry";

test("edge-only strokes are discarded without rejecting self-crossing outlines", () => {
  assert.equal(
    hasPolygonArea([
      [0, 0],
      [0, 20],
      [0, 80],
      [0, 10],
    ]),
    false,
  );
  assert.equal(
    hasPolygonArea([
      [10, 10],
      [10, 10],
    ]),
    false,
  );
  assert.equal(
    hasPolygonArea([
      [0, 0],
      [20, 20],
      [0, 20],
      [20, 0],
    ]),
    true,
  );
});

test("polygon area subtracts holes", () => {
  const square: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  const hole: [number, number][] = [
    [2, 2],
    [2, 4],
    [4, 4],
    [4, 2],
  ];
  const mark = { id: "a", type: "polygon" as const, points: square, jobId: 1 };
  assert.equal(measurePolygon(mark).area, 100);
  const m = measurePolygon({ ...mark, holes: [hole] });
  assert.equal(m.area, 96);
  // Same shape, scaled, as the CSV export test.
  assert.equal(m.perimeter, 48);
  assert.deepEqual([m.feretMin, Math.round(m.feretMax * 100) / 100], [10, 14.14]);
});

test("polygon area counts both lobes of a self-crossing outline", () => {
  const bowTie: [number, number][] = [
    [0, 0],
    [200, 200],
    [200, 0],
    [0, 200],
  ];
  const m = measurePolygon({ id: "b", type: "polygon", points: bowTie, jobId: 1 });
  assert.equal(m.area, 20000);
  assert.deepEqual([m.feretMin, Math.round(m.feretMax * 100) / 100], [200, 282.84]);
});

test("the brush picks the active class first, then the topmost mark of a shown class", () => {
  const at = (id: string, x: number, jobId: number) => ({
    id,
    type: "polygon" as const,
    jobId,
    points: [
      [x, 0],
      [x + 100, 0],
      [x + 100, 100],
      [x, 100],
    ] as [number, number][],
  });
  const marks = [at("a", 0, 1), at("b", 0, 2), at("c", 0, 3), at("d", 500, 2)];
  const pick = (x: number, jobId: number, shown: number[]) =>
    hitAnyMark(marks, [x, 50], 1, jobId, shown);
  assert.equal(pick(50, 1, [1, 2, 3]), "a");
  assert.equal(pick(50, 9, [1, 2, 3]), "c");
  assert.equal(pick(50, 9, [1, 2]), "b");
  assert.equal(pick(550, 1, [1, 2, 3]), "d");
  assert.equal(pick(550, 1, [1]), null);
  assert.equal(pick(300, 1, [1, 2, 3]), null);
});
