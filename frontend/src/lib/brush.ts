import { addRing, withHoles, type Mark } from "./draw";
import { pointInPoly, simplifyPolygon } from "./geometry";

export type BrushPoly = { points: [number, number][]; holes?: [number, number][][] };

export function jobPolys(marks: Mark[], jobId: number): BrushPoly[] {
  return marks
    .filter((m) => m.jobId === jobId && m.type === "polygon")
    .map((m) => withHoles({ points: m.points }, m.holes));
}

export function applyPolys(marks: Mark[], jobId: number, polys: BrushPoly[]): Mark[] {
  return [
    ...marks.filter((m) => m.jobId !== jobId || m.type !== "polygon"),
    ...polys.map((p) =>
      withHoles({ id: crypto.randomUUID(), type: "polygon" as const, points: p.points, jobId }, p.holes),
    ),
  ];
}

const N4: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const N8: [number, number][] = [...N4, [1, 1], [1, -1], [-1, 1], [-1, -1]];
const DX = [0, 1, 1, 1, 0, -1, -1, -1];
const DY = [-1, -1, 0, 1, 1, 1, 0, -1];

function fillPoly(ctx: CanvasRenderingContext2D, p: BrushPoly) {
  ctx.beginPath();
  addRing(ctx, p.points);
  for (const h of p.holes ?? []) addRing(ctx, h);
  ctx.fill("evenodd");
}

function components(on: Uint8Array, w: number, h: number, want: 0 | 1, n8: boolean) {
  const lab = new Int32Array(w * h);
  const neigh = n8 ? N8 : N4;
  const qx = new Int32Array(w * h);
  const qy = new Int32Array(w * h);
  const border = [false];
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (lab[i] || on[i] !== want) continue;
      n++;
      let head = 0;
      let tail = 0;
      qx[tail] = x;
      qy[tail] = y;
      tail++;
      lab[i] = n;
      let edge = false;
      while (head < tail) {
        const cx = qx[head];
        const cy = qy[head];
        head++;
        if (cx === 0 || cy === 0 || cx === w - 1 || cy === h - 1) edge = true;
        for (const [dx, dy] of neigh) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (lab[j] || on[j] !== want) continue;
          lab[j] = n;
          qx[tail] = nx;
          qy[tail] = ny;
          tail++;
        }
      }
      border[n] = edge;
    }
  }
  return { lab, n, border };
}

function firstPixel(lab: Int32Array, id: number, w: number, h: number): [number, number] | null {
  for (let i = 0; i < lab.length; i++) if (lab[i] === id) return [i % w, (i / w) | 0];
  return null;
}

function trace(inside: (x: number, y: number) => boolean, w: number, h: number, x0: number, y0: number) {
  const pts: [number, number][] = [];
  let x = x0;
  let y = y0;
  let dir = 7;
  const max = w * h * 2;
  for (let n = 0; n < max; n++) {
    pts.push([x + 0.5, y + 0.5]);
    let found = -1;
    for (let k = 0; k < 8; k++) {
      const i = (dir + k) % 8;
      const nx = x + DX[i];
      const ny = y + DY[i];
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && inside(nx, ny)) {
        found = i;
        break;
      }
    }
    if (found < 0) break;
    x += DX[found];
    y += DY[found];
    dir = (found + 5) % 8;
    if (x === x0 && y === y0) break;
  }
  const a = pts[0];
  const b = pts[pts.length - 1];
  if (a && b && a[0] === b[0] && a[1] === b[1] && pts.length > 1) pts.pop();
  return pts;
}

function ringArea(pts: [number, number][]) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return Math.abs(a);
}

function simplifyRing(pts: [number, number][]) {
  const out = simplifyPolygon(pts);
  return out.length >= 3 ? out : null;
}

export function maskToPolygons(img: ImageData): BrushPoly[] {
  const { width: w, height: h, data } = img;
  const on = new Uint8Array(w * h);
  for (let i = 0; i < on.length; i++) on[i] = data[i * 4 + 3] > 127 ? 1 : 0;
  const fg = components(on, w, h, 1, true);
  const bg = components(on, w, h, 0, false);
  const outers: { points: [number, number][]; area: number }[] = [];
  for (let id = 1; id <= fg.n; id++) {
    const start = firstPixel(fg.lab, id, w, h);
    if (!start) continue;
    const raw = trace((x, y) => fg.lab[y * w + x] === id, w, h, start[0], start[1]);
    const points = simplifyRing(raw);
    if (points) outers.push({ points, area: ringArea(points) });
  }
  const holes: [number, number][][][] = outers.map(() => []);
  for (let id = 1; id <= bg.n; id++) {
    if (bg.border[id]) continue;
    const start = firstPixel(bg.lab, id, w, h);
    if (!start) continue;
    const raw = trace((x, y) => bg.lab[y * w + x] === id, w, h, start[0], start[1]);
    const hole = simplifyRing(raw);
    if (!hole) continue;
    const probe: [number, number] = [start[0] + 0.5, start[1] + 0.5];
    let best = -1;
    let bestA = Infinity;
    for (let i = 0; i < outers.length; i++) {
      if (pointInPoly(probe, outers[i].points) && outers[i].area < bestA) {
        bestA = outers[i].area;
        best = i;
      }
    }
    if (best >= 0) holes[best].push(hole);
  }
  return outers.map((o, i) => (holes[i].length ? { points: o.points, holes: holes[i] } : { points: o.points }));
}

export type Brush = {
  width: number;
  height: number;
  enter: (polys: BrushPoly[]) => void;
  stamp: (points: [number, number][], radius: number, erase: boolean) => void;
  toPolygons: () => BrushPoly[];
};

export function createBrush(width: number, height: number): Brush {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

  function enter(polys: BrushPoly[]) {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#fff";
    for (const p of polys) fillPoly(ctx, p);
  }

  function stamp(points: [number, number][], radius: number, erase: boolean) {
    if (!points.length) return;
    ctx.save();
    ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
    ctx.fillStyle = ctx.strokeStyle = "#fff";
    ctx.lineWidth = radius * 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    if (points.length === 1) ctx.arc(points[0][0], points[0][1], radius, 0, Math.PI * 2);
    else {
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
    }
    points.length === 1 ? ctx.fill() : ctx.stroke();
    ctx.restore();
  }

  return {
    width,
    height,
    enter,
    stamp,
    toPolygons: () => maskToPolygons(ctx.getImageData(0, 0, width, height)),
  };
}
