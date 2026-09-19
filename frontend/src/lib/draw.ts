import type { Job } from "@/lib/api";

export type Mark = { id: string; type: "point" | "polygon"; points: [number, number][]; jobId: number };

export type Space = {
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
    imgLeft: rect.left,
    imgTop: rect.top,
    ox: (rect.width - img.naturalWidth * scale) / 2,
    oy: (rect.height - img.naturalHeight * scale) / 2,
    scale,
    rootLeft: rootRect.left,
    rootTop: rootRect.top,
  };
}

export function imagePoint(e: PointerEvent, s: Space): [number, number] {
  return [(e.clientX - s.imgLeft - s.ox) / s.scale, (e.clientY - s.imgTop - s.oy) / s.scale];
}

export function screenPoint(e: PointerEvent, s: Space): [number, number] {
  return [e.clientX - s.rootLeft, e.clientY - s.rootTop];
}

export function imageToScreen(p: [number, number], s: Space): [number, number] {
  return [p[0] * s.scale + s.ox + (s.imgLeft - s.rootLeft), p[1] * s.scale + s.oy + (s.imgTop - s.rootTop)];
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

function poly(ctx: CanvasRenderingContext2D, pts: [number, number][], color: string, highlight = false) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.globalAlpha = highlight ? 0.35 : 0.25;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (highlight) {
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 5;
    ctx.stroke();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
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

export function paintScene(
  ctx: CanvasRenderingContext2D,
  root: HTMLElement,
  marks: Mark[],
  draft: [number, number][],
  jobs: Job[],
  focusId: string | null = null,
  selectedId: string | null = null,
  insertAt: [number, number] | null = null,
) {
  ctx.clearRect(0, 0, root.clientWidth, root.clientHeight);
  const s = measureSpace(root);
  if (!s) return;
  for (const m of marks) {
    const color = jobs.find((j) => j.id === m.jobId)?.color || "#fafafa";
    const on = m.id === focusId;
    if (m.type === "point" && m.points[0]) {
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
      const screen = m.points.map((p) => imageToScreen(p, s));
      poly(ctx, screen, color, on);
      if (m.id === selectedId) handles(ctx, screen, color);
    }
  }
  if (insertAt) {
    const [x, y] = imageToScreen(insertAt, s);
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  if (draft.length > 1) poly(ctx, draft, "#fff");
}
