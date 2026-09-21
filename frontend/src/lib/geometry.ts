import { polyRings, type Mark } from "./draw";

const SIMPLIFY_MIN_PX = 1.5;
const SIMPLIFY_DIAG_RATIO = 0.0065;

function closestOnSegment(p: [number, number], a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  const point: [number, number] = [a[0] + t * dx, a[1] + t * dy];
  return { t, point, dist: Math.hypot(p[0] - point[0], p[1] - point[1]) };
}

function autoEpsilon(points: [number, number][]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return Math.max(SIMPLIFY_MIN_PX, Math.hypot(maxX - minX, maxY - minY) * SIMPLIFY_DIAG_RATIO);
}

function simplifyRdp(points: [number, number][], epsilon: number): [number, number][] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    const a = points[start];
    const b = points[end];
    let maxD = 0;
    let idx = -1;
    for (let i = start + 1; i < end; i++) {
      const d = closestOnSegment(points[i], a, b).dist;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > epsilon) {
      keep[idx] = 1;
      stack.push([start, idx], [idx, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

export function simplifyPolygon(points: [number, number][], epsilon?: number): [number, number][] {
  if (points.length < 3) return points;
  const out = simplifyRdp(points, epsilon ?? autoEpsilon(points));
  return out.length >= 3 ? out : points;
}

export function pointInPoly(pt: [number, number], poly: [number, number][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi || 1e-12) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function inMark(pt: [number, number], m: Mark) {
  if (!pointInPoly(pt, m.points)) return false;
  return !(m.holes ?? []).some((h) => pointInPoly(pt, h));
}

export function hitVertex(rings: [number, number][][], pt: [number, number], r: number) {
  let best: { ring: number; index: number } | null = null;
  let bestD = r;
  for (let ring = 0; ring < rings.length; ring++) {
    for (let i = 0; i < rings[ring].length; i++) {
      const d = Math.hypot(pt[0] - rings[ring][i][0], pt[1] - rings[ring][i][1]);
      if (d <= bestD) {
        bestD = d;
        best = { ring, index: i };
      }
    }
  }
  return best;
}

function hitEdge(points: [number, number][], pt: [number, number], r: number) {
  let best: { i: number; t: number; point: [number, number] } | null = null;
  let bestD = r;
  for (let i = 0; i < points.length; i++) {
    const hit = closestOnSegment(pt, points[i], points[(i + 1) % points.length]);
    if (hit.dist <= bestD) {
      bestD = hit.dist;
      best = { i, t: hit.t, point: hit.point };
    }
  }
  return best;
}

export function insertTarget(rings: [number, number][][], pt: [number, number], scale: number) {
  const r = 12 / scale;
  let best: { ring: number; i: number; point: [number, number] } | null = null;
  let bestD = r;
  for (let ring = 0; ring < rings.length; ring++) {
    const points = rings[ring];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const d = Math.hypot(pt[0] - mid[0], pt[1] - mid[1]);
      const nearerEnd = Math.min(Math.hypot(pt[0] - a[0], pt[1] - a[1]), Math.hypot(pt[0] - b[0], pt[1] - b[1]));
      if (d <= bestD && d < nearerEnd) {
        bestD = d;
        best = { ring, i, point: mid };
      }
    }
  }
  return best;
}

export function hitMark(marks: Mark[], pt: [number, number], scale: number, jobId: number) {
  const r = 10 / scale;
  for (let i = marks.length - 1; i >= 0; i--) {
    const m = marks[i];
    if (m.jobId !== jobId) continue;
    if (m.type === "point") {
      const p = m.points[0];
      if (p && Math.hypot(pt[0] - p[0], pt[1] - p[1]) <= r) return m.id;
    } else if (m.points.length > 2 && (inMark(pt, m) || polyRings(m).some((ring) => hitEdge(ring, pt, r)))) {
      return m.id;
    }
  }
  return null;
}
