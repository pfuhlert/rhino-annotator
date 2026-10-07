import * as clipping from "./clipping";
import type { Polygon as BrushPoly, Pair } from "./clipping";
import { withHoles, type Mark } from "./draw";
import { simplifyLine } from "./geometry";

export type { BrushPoly };

export function jobPolys(marks: Mark[], jobId: number): BrushPoly[] {
  return marks.filter((m) => m.jobId === jobId && m.type === "polygon");
}

export function applyPolys(marks: Mark[], jobId: number, polys: BrushPoly[]): Mark[] {
  const existing = new Map(
    marks.filter((m) => m.jobId === jobId && m.type === "polygon").map((m) => [m.points, m]),
  );
  const kept = new Set(polys.map((p) => p.points));
  // Edited polygons come back as new shapes; reusing an overlapping old id keeps the annotation's
  // identity (and its creation time) across brush edits.
  const replaced = [...existing.values()].filter((m) => !kept.has(m.points));
  const idFor = (points: Pair[]) => {
    const box = bounds(points);
    const i = replaced.findIndex((m) => overlaps(box, bounds(m.points)));
    return i < 0 ? crypto.randomUUID() : replaced.splice(i, 1)[0].id;
  };
  return [
    ...marks.filter((m) => m.jobId !== jobId || m.type !== "polygon"),
    ...polys.map(
      (p) =>
        existing.get(p.points) ??
        withHoles(
          { id: idFor(p.points), type: "polygon" as const, points: p.points, jobId },
          p.holes,
        ),
    ),
  ];
}

// Maximum approximation error in image pixels, independent of brush size.
const STROKE_ERROR = 1;
type Bounds = [number, number, number, number];
type Stroke = { points: Pair[]; radius: number; erase: boolean };

function bounds(points: Pair[], padding = 0): Bounds {
  const box: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of points) {
    box[0] = Math.min(box[0], x);
    box[1] = Math.min(box[1], y);
    box[2] = Math.max(box[2], x);
    box[3] = Math.max(box[3], y);
  }
  return [box[0] - padding, box[1] - padding, box[2] + padding, box[3] + padding];
}

function overlaps(a: Bounds, b: Bounds) {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

export type Brush = {
  width: number;
  height: number;
  enter: (polys: BrushPoly[]) => void;
  stamp: (points: Pair[], radius: number, erase: boolean) => void;
  toPolygons: () => BrushPoly[];
};

export function createBrush(width: number, height: number): Brush {
  let polys: BrushPoly[] = [];
  const boxes = new WeakMap<BrushPoly, Bounds>();
  let originals = new WeakSet<BrushPoly>();
  const pending: Stroke[] = [];
  const image: BrushPoly[] = [
    {
      points: [
        [0, 0],
        [width, 0],
        [width, height],
        [0, height],
      ],
    },
  ];

  function enter(next: BrushPoly[]) {
    polys = next;
    for (const p of polys) boxes.set(p, bounds(p.points));
    originals = new WeakSet(next);
    pending.length = 0;
  }

  function stamp(points: Pair[], radius: number, erase: boolean) {
    if (!points.length || radius <= 0) return;
    let stroke = pending.at(-1);
    const last = stroke?.points.at(-1);
    if (
      !stroke ||
      stroke.erase !== erase ||
      stroke.radius !== radius ||
      last?.[0] !== points[0][0] ||
      last?.[1] !== points[0][1]
    ) {
      stroke = { points: [points[0]], radius, erase };
      pending.push(stroke);
    }
    for (let i = 1; i < points.length; i++) stroke.points.push(points[i]);
  }

  function toPolygons() {
    for (const stroke of pending) {
      const box = bounds(stroke.points, stroke.radius);
      if (!overlaps(box, [0, 0, width, height])) continue;
      const untouched: BrushPoly[] = [],
        touched: BrushPoly[] = [];
      for (const p of polys) {
        if (overlaps(box, boxes.get(p)!)) touched.push(p);
        else untouched.push(p);
      }
      if (stroke.erase && !touched.length) continue;
      // Split the pixel error budget between the centerline (40%) and round edges (60%).
      const points = simplifyLine(stroke.points, STROKE_ERROR * 0.4);
      let footprint = clipping.stroke(points, stroke.radius, STROKE_ERROR * 0.6);
      if (box[0] < 0 || box[1] < 0 || box[2] > width || box[3] > height) {
        footprint = clipping.intersection(footprint, image);
      }
      if (!footprint.length) continue;
      // Normalize each source polygon separately: their overlapping fills must still unite.
      const subject = touched.flatMap((p) => (originals.has(p) ? clipping.normalize(p) : [p]));
      const result = stroke.erase
        ? clipping.difference(subject, footprint)
        : clipping.union(subject, footprint);
      polys = [...untouched, ...result];
      for (const p of result) boxes.set(p, bounds(p.points));
    }
    pending.length = 0;
    return polys;
  }

  return { width, height, enter, stamp, toPolygons };
}
