import type { AiTask, Element, Job } from "@/lib/api";

export type Tool = "point" | "polygon" | "brush";
export type Mark = Element;

export function polyRings(m: Mark): [number, number][][] {
  return m.holes?.length ? [m.points, ...m.holes] : [m.points];
}

export function withHoles<T extends object, H>(obj: T, holes?: H[][][]): T {
  return holes?.length ? { ...obj, holes } : obj;
}

export function ringOf(m: Mark, ring: number) {
  return ring === 0 ? m.points : m.holes?.[ring - 1];
}

export function shiftMark(m: Mark, dx: number, dy: number) {
  m.points = m.points.map(([x, y]) => [x + dx, y + dy]);
  if (m.holes) m.holes = m.holes.map((h) => h.map(([x, y]) => [x + dx, y + dy]));
}

export type Space = {
  imageWidth: number;
  imageHeight: number;
  imgLeft: number;
  imgTop: number;
  ox: number;
  oy: number;
  scale: number;
  rootLeft: number;
  rootTop: number;
};

export function measureSpace(root: HTMLElement): Space | null {
  const img = root.querySelector("img");
  if (!img?.naturalWidth) return null;
  const rect = img.getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();
  const scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
  return {
    imageWidth: img.naturalWidth,
    imageHeight: img.naturalHeight,
    imgLeft: rect.left,
    imgTop: rect.top,
    ox: (rect.width - img.naturalWidth * scale) / 2,
    oy: (rect.height - img.naturalHeight * scale) / 2,
    scale,
    rootLeft: rootRect.left,
    rootTop: rootRect.top,
  };
}

export type PointerPosition = Pick<PointerEvent, "clientX" | "clientY">;

export function imagePoint(e: PointerPosition, s: Space): [number, number] {
  return [(e.clientX - s.imgLeft - s.ox) / s.scale, (e.clientY - s.imgTop - s.oy) / s.scale];
}

export function imageToScreen(p: [number, number], s: Space): [number, number] {
  return [
    p[0] * s.scale + s.ox + (s.imgLeft - s.rootLeft),
    p[1] * s.scale + s.oy + (s.imgTop - s.rootTop),
  ];
}

export function imageScreenRect(s: Space) {
  const [left, top] = imageToScreen([0, 0], s);
  return { left, top, right: left + s.imageWidth * s.scale, bottom: top + s.imageHeight * s.scale };
}

export function setupCanvas(canvas: HTMLCanvasElement, root: HTMLElement) {
  const r = root.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(r.width * dpr);
  const h = Math.round(r.height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  canvas.style.width = `${r.width}px`;
  canvas.style.height = `${r.height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export function addRing(ctx: CanvasRenderingContext2D, pts: [number, number][], close = true) {
  if (pts.length < 2) return;
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  if (close) ctx.closePath();
}

function poly(
  ctx: CanvasRenderingContext2D,
  rings: [number, number][][],
  color: string,
  highlight = false,
  fillOnly = false,
) {
  ctx.beginPath();
  for (const pts of rings) addRing(ctx, pts);
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = color;
  ctx.fill("evenodd");
  ctx.globalAlpha = 1;
  if (fillOnly) return;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (highlight) {
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();
}

function handles(ctx: CanvasRenderingContext2D, pts: [number, number][], color: string) {
  for (const [x, y] of pts) {
    ctx.beginPath();
    ctx.rect(x - 4, y - 4, 8, 8);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

function draftStroke(ctx: CanvasRenderingContext2D, pts: [number, number][], color: string) {
  if (pts.length < 2) return;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  addRing(ctx, pts, false);
  ctx.stroke();
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  ctx.lineTo(pts[0][0], pts[0][1]);
  ctx.stroke();
  ctx.setLineDash([]);
}

export type SceneOpts = {
  pending?: AiTask[];
  draft?: [number, number][];
  draftColor?: string;
  hoverId?: string | null;
  selectedId?: string | null;
  insertAt?: [number, number] | null;
  tool?: Tool;
  brush?: {
    r: number;
    color: string;
    points: [number, number][];
    erase?: boolean;
  } | null;
};

function brushStroke(
  ctx: CanvasRenderingContext2D,
  pts: [number, number][],
  r: number,
  s: Space,
  color: string,
  erase: boolean,
) {
  if (!pts.length) return;
  ctx.save();
  const { left, top, right, bottom } = imageScreenRect(s);
  ctx.beginPath();
  ctx.rect(left, top, right - left, bottom - top);
  ctx.clip();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = r * 2 * s.scale;
  if (erase) {
    ctx.globalCompositeOperation = "destination-out";
    ctx.strokeStyle = ctx.fillStyle = "#000";
    ctx.globalAlpha = 1;
  } else {
    ctx.strokeStyle = ctx.fillStyle = color;
    ctx.globalAlpha = 0.28;
  }
  const p0 = imageToScreen(pts[0], s);
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(p0[0], p0[1], r * s.scale, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(p0[0], p0[1]);
    for (let i = 1; i < pts.length; i++) {
      const p = imageToScreen(pts[i], s);
      ctx.lineTo(p[0], p[1]);
    }
    ctx.stroke();
  }
  ctx.restore();
}

export function paintScene(
  ctx: CanvasRenderingContext2D,
  root: HTMLElement,
  marks: Mark[],
  jobs: Job[],
  opts: SceneOpts = {},
) {
  const draft = opts.draft ?? [];
  const fillOnly = opts.tool === "brush";
  ctx.clearRect(0, 0, root.clientWidth, root.clientHeight);
  const s = measureSpace(root);
  if (!s) return;
  for (const m of marks) {
    const color = jobs.find((j) => j.id === m.jobId)?.color;
    if (!color) continue;
    if (m.type === "point" && m.points[0]) {
      const on = !fillOnly && (m.id === opts.selectedId || m.id === opts.hoverId);
      const [x, y] = imageToScreen(m.points[0], s);
      ctx.beginPath();
      ctx.arc(x, y, on ? 10 : 8, 0, Math.PI * 2);
      ctx.globalAlpha = on ? 0.45 : 0.35;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (on) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 4;
        ctx.stroke();
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    } else if (m.points.length > 1) {
      const rings = polyRings(m).map((ring) => ring.map((p) => imageToScreen(p, s)));
      const halo = !fillOnly && m.id === opts.hoverId && m.id !== opts.selectedId;
      poly(ctx, rings, color, halo, fillOnly);
      if (!fillOnly && m.id === opts.selectedId) {
        for (const ring of rings) handles(ctx, ring, color);
      }
    }
  }
  for (const task of opts.pending ?? []) {
    const [x, y] = imageToScreen([task.x, task.y], s);
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.strokeStyle =
      task.status === "failed"
        ? "#f87171"
        : (jobs.find((j) => j.id === task.job_id)?.color ?? "#fff");
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillRect(x - 2, y - 2, 4, 4);
  }
  const brush = opts.brush;
  if (brush?.points.length) brushStroke(ctx, brush.points, brush.r, s, brush.color, !!brush.erase);
  if (!fillOnly && opts.insertAt) {
    const [x, y] = imageToScreen(opts.insertAt, s);
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  if (draft.length > 1) draftStroke(ctx, draft, opts.draftColor || "#fafafa");
}
