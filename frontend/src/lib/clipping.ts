import {
  Clipper64,
  ClipperOffset,
  ClipType,
  EndType,
  FillRule,
  JoinType,
  PolyTree64,
  type PolyPath64,
} from "clipper2-ts";
import { withHoles } from "./draw";

export type Pair = [number, number];
export type Polygon = { points: Pair[]; holes?: Pair[][] };

// Integer geometry avoids unstable comparisons at nearly coincident intersections.
const SCALE = 1e8;
const integerPoint = ([x, y]: Pair) => ({ x: Math.round(x * SCALE), y: Math.round(y * SCALE) });

function clip(
  type: ClipType,
  subject: Polygon[],
  other: Polygon[] = [],
  fill = FillRule.NonZero,
): Polygon[] {
  const originals = new Map<string, Pair>();
  // Boolean inputs have canonical winding; normalize() accepts arbitrary even-odd rings.
  const paths = (polys: Polygon[]) =>
    polys.flatMap((poly) =>
      [poly.points, ...(poly.holes ?? [])].map((ring) =>
        ring.map((point) => {
          const { x, y } = integerPoint(point);
          const key = `${x},${y}`;
          if (!originals.has(key)) originals.set(key, point);
          return { x, y };
        }),
      ),
    );
  const engine = new Clipper64(),
    tree = new PolyTree64();
  engine.addSubject(paths(subject));
  engine.addClip(paths(other));
  if (!engine.execute(type, fill, tree)) throw new Error("Unable to clip brush geometry");
  return fromTree(tree, originals);
}

function fromTree(tree: PolyTree64, originals?: Map<string, Pair>): Polygon[] {
  const result: Polygon[] = [];
  const ring = (node: PolyPath64): Pair[] =>
    node.poly!.map(({ x, y }): Pair => originals?.get(`${x},${y}`) ?? [x / SCALE, y / SCALE]);
  function collect(node: PolyPath64) {
    for (let i = 0; i < node.count; i++) {
      const outer = node.child(i),
        holes: Pair[][] = [];
      for (let j = 0; j < outer.count; j++) {
        const hole = outer.child(j);
        holes.push(ring(hole));
        collect(hole);
      }
      result.push(withHoles({ points: ring(outer) }, holes));
    }
  }
  collect(tree);
  return result;
}

export function stroke(points: Pair[], radius: number, arcError: number): Polygon[] {
  const engine = new ClipperOffset(2, Math.min(arcError, radius) * SCALE);
  const tree = new PolyTree64();
  engine.addPath(points.map(integerPoint), JoinType.Round, EndType.Round);
  engine.execute(radius * SCALE, tree);
  return fromTree(tree);
}

export const normalize = (poly: Polygon) => clip(ClipType.Union, [poly], [], FillRule.EvenOdd);
export const union = (a: Polygon[], b: Polygon[]) => clip(ClipType.Union, a, b);
export const difference = (a: Polygon[], b: Polygon[]) => clip(ClipType.Difference, a, b);
export const intersection = (a: Polygon[], b: Polygon[]) => clip(ClipType.Intersection, a, b);
