export function distPointToSegment(p: [number, number], a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
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
  return Math.max(2, Math.hypot(maxX - minX, maxY - minY) * 0.008);
}

/** Ramer–Douglas–Peucker; epsilon is in the same units as the points. */
export function simplifyRdp(points: [number, number][], epsilon: number): [number, number][] {
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
      const d = distPointToSegment(points[i], a, b);
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
