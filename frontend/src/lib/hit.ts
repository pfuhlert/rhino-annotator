import type { Mark } from "./draw";
import { distPointToSegment } from "./simplify";

function pointInPoly(pt: [number, number], poly: [number, number][]) {
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

function project(p: [number, number], a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return { t, point: [a[0] + t * dx, a[1] + t * dy] as [number, number] };
}

export function hitVertex(points: [number, number][], pt: [number, number], r: number) {
  let best = -1;
  let bestD = r;
  for (let i = 0; i < points.length; i++) {
    const d = Math.hypot(pt[0] - points[i][0], pt[1] - points[i][1]);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best >= 0 ? best : null;
}

export function hitEdge(points: [number, number][], pt: [number, number], r: number) {
  let best: { i: number; t: number; point: [number, number] } | null = null;
  let bestD = r;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const d = distPointToSegment(pt, a, b);
    if (d <= bestD) {
      bestD = d;
      const { t, point } = project(pt, a, b);
      best = { i, t, point };
    }
  }
  return best;
}

export function insertTarget(points: [number, number][], pt: [number, number], scale: number) {
  const r = 12 / scale;
  let best: { i: number; t: number; point: [number, number] } | null = null;
  let bestD = r;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const d = Math.hypot(pt[0] - mid[0], pt[1] - mid[1]);
    const nearerEnd = Math.min(Math.hypot(pt[0] - a[0], pt[1] - a[1]), Math.hypot(pt[0] - b[0], pt[1] - b[1]));
    if (d <= bestD && d < nearerEnd) {
      bestD = d;
      best = { i, t: 0.5, point: mid };
    }
  }
  return best;
}

export function hitMark(marks: Mark[], pt: [number, number], scale: number) {
  const r = 10 / scale;
  for (let i = marks.length - 1; i >= 0; i--) {
    const m = marks[i];
    if (m.type === "point") {
      const p = m.points[0];
      if (p && Math.hypot(pt[0] - p[0], pt[1] - p[1]) <= r) return m.id;
    } else if (m.points.length > 2 && (pointInPoly(pt, m.points) || hitEdge(m.points, pt, r))) {
      return m.id;
    }
  }
  return null;
}
