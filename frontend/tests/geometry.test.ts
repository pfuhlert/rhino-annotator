import assert from "node:assert/strict";
import test from "node:test";
import { hasPolygonArea, measurePolygon } from "../src/lib/geometry";

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
