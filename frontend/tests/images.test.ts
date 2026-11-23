import assert from "node:assert/strict";
import test from "node:test";
import type { ImageRow, Patch } from "../src/lib/api";
import { groupImages, rowMark, strongest } from "../src/lib/images";

const row = (id: string, group: string, staining: string | null, regions: number | null = null) =>
  ({
    id,
    name: id,
    group,
    staining,
    magnification: null,
    regions,
    visited: 0,
    annotations: 0,
    split: null,
  }) as ImageRow;

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
  const whole = { item_id: "a", slide: null } as unknown as Patch;
  const [first] = groupImages(rows, [], whole);
  assert.deepEqual([first.rows[0].visited, first.rows[0].regions, first.done], [0, 4, 0]);
});

test("a group takes the strongest mark of its images", () => {
  const annotated = rows.map((r) => (r.id === "b" ? { ...r, annotations: 2 } : r));
  const [first, second] = groupImages(annotated, [], null);
  assert.deepEqual([first.mark, second.mark], ["annotated", null]);
});

test("annotated outranks visited, which outranks untouched", () => {
  const at = (visited: number, annotations: number) =>
    ({ ...row("x", "g", null, 2), visited, annotations }) as ImageRow;
  assert.deepEqual([at(2, 1), at(1, 0), at(0, 0)].map(rowMark), ["annotated", "visited", null]);
  assert.equal(strongest(["visited", null, "annotated"]), "annotated");
  assert.equal(strongest([null, "visited"]), "visited");
  assert.equal(strongest([]), null);
});

test("the magnification filter keeps only the chosen magnifications", () => {
  const row = (id: string, magnification: number | null) => ({
    id,
    name: `${id}.tif`,
    group: "R1",
    staining: null,
    magnification,
    regions: null,
    visited: 0,
    annotations: 0,
    split: null,
  });
  const rows = [row("a", 6000), row("b", 12000), row("c", null)];
  const ids = (mags: (number | null)[]) =>
    groupImages(rows, [], null, mags).flatMap((g) => g.rows.map((r) => r.id));
  assert.deepEqual(ids([]), ["a", "b", "c"]);
  assert.deepEqual(ids([6000]), ["a"]);
  assert.deepEqual(ids([12000, null]), ["b", "c"]);
});
