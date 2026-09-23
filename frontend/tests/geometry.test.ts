import assert from "node:assert/strict";
import test from "node:test";
import { hasPolygonArea } from "../src/lib/geometry";

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
