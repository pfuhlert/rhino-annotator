import assert from "node:assert/strict";
import test from "node:test";
import type { ImageRow, Patch } from "../src/lib/api";
import { groupImages } from "../src/lib/images";

const row = (id: string, group: string, staining: string | null, regions: number | null = null) =>
  ({ id, name: id, group, staining, magnification: null, regions, visited: 0 }) as ImageRow;

const rows = [
  row("a", "case-2", "PAS", 4),
  row("b", "case-2", "HE"),
  row("c", "case-10", null, 1),
  row("d", "case-10", "PAS"),
];

test("filter hides rows and groups left empty", () => {
  const groups = groupImages(rows, ["HE", null], null);
  assert.deepEqual(
    groups.map((g) => [g.name, g.rows.map((r) => r.id)]),
    [
      ["case-2", ["b"]],
      ["case-10", ["c"]],
    ],
  );
  assert.deepEqual(
    groupImages(rows, ["IgG"], null).map((g) => g.name),
    [],
  );
});

test("the open image's progress comes from its patch", () => {
  const slide = {
    tiles: [
      [0, 0, 1, 1, true],
      [1, 0, 1, 1, true],
      [2, 0, 1, 1, false],
    ],
  };
  const atA = { item_id: "a", slide } as unknown as Patch;
  const [first] = groupImages(rows, [], atA);
  assert.deepEqual(
    first.rows.map((r) => [r.id, r.visited, r.regions]),
    [
      ["a", 2, 3],
      ["b", 0, null],
    ],
  );
  assert.equal(first.done, 0);
});

test("a patch without a slide view keeps the fetched progress", () => {
  const legacyCrop = { item_id: "a", slide: null } as unknown as Patch;
  const [first] = groupImages(rows, [], legacyCrop);
  assert.deepEqual([first.rows[0].visited, first.rows[0].regions, first.done], [0, 4, 0]);
});
