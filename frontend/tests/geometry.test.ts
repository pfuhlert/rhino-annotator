import assert from "node:assert/strict";
import test from "node:test";
import { hasPolygonArea, polygonArea } from "../src/lib/geometry";

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
  assert.equal(polygonArea(mark), 100);
  assert.equal(polygonArea({ ...mark, holes: [hole] }), 96);
});

test("polygon area counts both lobes of a self-crossing outline", () => {
  const bowTie: [number, number][] = [
    [0, 0],
    [200, 200],
    [200, 0],
    [0, 200],
  ];
  assert.equal(polygonArea({ id: "b", type: "polygon", points: bowTie, jobId: 1 }), 20000);
});
