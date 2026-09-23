import { useEffect, useRef, type RefObject } from "react";
import type { AiTask, Job } from "@/lib/api";
import { applyPolys, createBrush, jobPolys, type Brush } from "./brush";
import { createBrushCursor } from "./brush-cursor";
import {
  imagePoint,
  imageToScreen,
  measureSpace,
  paintScene,
  polyRings,
  ringOf,
  setupCanvas,
  type Mark,
  type PointerPosition,
  type Space,
  type Tool,
} from "./draw";
import { hasPolygonArea, hitMark, hitVertex, insertTarget, simplifyPolygon } from "./geometry";
import {
  brushTouchesImage,
  clampToImage,
  insideImageBounds,
  insidePixelBounds,
  moveWithinImage,
} from "./image-bounds";
import { isTypingTarget } from "./keys";

type Ctl = {
  flush: () => void;
  reset: (clearSelect?: boolean) => void;
  add: (marks: Mark[]) => void;
};

export function useFreehand(opts: {
  rootRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  cursorRef: RefObject<HTMLDivElement | null>;
  imgRef: RefObject<HTMLImageElement | null>;
  tool: Tool;
  jobId: number;
  marksRef: RefObject<Mark[]>;
  jobs: Job[];
  radius: number;
  onRadiusChange: (radius: number) => void;
  onChangeRef: RefObject<(() => void) | undefined>;
  pending?: AiTask[];
  onAiPoint?: (point: [number, number]) => void;
  onRemote?: (marks: Mark[]) => void;
  onViewChange?: (space: Space | null) => void;
}): Ctl {
  const { rootRef, canvasRef, cursorRef, imgRef, tool, jobId, marksRef, onChangeRef, radius } =
    opts;
  const latest = useRef(opts);
  useEffect(() => {
    latest.current = opts;
  });
  const ctl = useRef<Ctl & { redraw: () => void; cursor: () => void }>({
    flush() {},
    reset() {},
    redraw() {},
    cursor() {},
    add() {},
  });

  useEffect(() => {
    if (!rootRef.current || !canvasRef.current || !cursorRef.current) return;
    const root = rootRef.current;
    const canvas = canvasRef.current;
    const brushCursor = createBrushCursor(cursorRef.current);
    const view = { z: 1, x: 0, y: 0 };

    const seen = new Set(marksRef.current.map((m) => m.id));
    const incoming: Mark[] = [];
    let drawing = false;
    let painting = false;
    let erasing = false;
    let brush: Brush | null = null;
    let brushJobId = latest.current.jobId;
    let stampedPoints = 0;
    let space = measureSpace(root);
    let ctx = setupCanvas(canvas, root);
    let selected: string | null = null;
    let hover: string | null = null;
    let pointer: PointerPosition | null = null;
    let drag:
      | { kind: "move"; id: string; last: [number, number] }
      | { kind: "vertex"; id: string; ring: number; index: number }
      | null = null;
    let insertAt: [number, number] | null = null;
    let dirty = false;
    const stroke: [number, number][] = [];
    const draft: [number, number][] = [];

    function changed() {
      onChangeRef.current?.();
    }

    function pad() {
      return space ? 18 / space.scale : 18;
    }

    function brushing() {
      return latest.current.tool === "brush";
    }

    function ensureBrush() {
      const img = imgRef.current;
      if (!img?.naturalWidth) return null;
      if (!brush || brush.width !== img.naturalWidth || brush.height !== img.naturalHeight) {
        brush = createBrush(img.naturalWidth, img.naturalHeight);
        brushJobId = latest.current.jobId;
        brush.enter(jobPolys(marksRef.current, brushJobId));
      }
      return brush;
    }

    function cancelGesture() {
      drawing = false;
      painting = false;
      drag = null;
      dirty = false;
      stroke.length = 0;
      draft.length = 0;
    }

    function reset(clearSelect = false) {
      cancelGesture();
      if (clearSelect) selected = null;
      hover = null;
      insertAt = null;
      brush = null;
      if (brushing()) ensureBrush();
      drain();
      applyView();
    }

    function drain() {
      if (drawing || painting || drag || !incoming.length) return;
      while (incoming.length) {
        const mark = incoming.shift()!;
        marksRef.current = [...marksRef.current, mark];
        brush = null;
        latest.current.onRemote?.([mark]);
        changed();
      }
      redraw();
    }

    function add(marks: Mark[]) {
      for (const mark of marks) {
        if (seen.has(mark.id)) continue;
        seen.add(mark.id);
        incoming.push(mark);
      }
      drain();
    }

    function flush() {
      endPaint();
      cancelGesture();
      drain();
      redraw();
    }

    ctl.current = { flush, reset, redraw, cursor, add };

    function edgeInsert(e: PointerPosition, id: string | null) {
      if (!space || !id) return null;
      const m = marksRef.current.find((x) => x.id === id);
      if (m?.type !== "polygon") return null;
      const rings = polyRings(m);
      const pt = imagePoint(e, space);
      if (hitVertex(rings, pt, pad())) return null;
      return insertTarget(rings, pt, space.scale);
    }

    function canStartAt(point: [number, number]) {
      const contains = latest.current.tool === "point" ? insidePixelBounds : insideImageBounds;
      return space !== null && contains(point, space);
    }

    function cursorAt() {
      if (brushing())
        return brushCursor.update(
          pointer,
          space,
          space ? latest.current.radius * space.scale : null,
        );
      if (drag?.kind === "vertex") return "move";
      if (drag) return "grabbing";
      if (insertAt) return "copy";
      if (pointer && selected && space) {
        const m = marksRef.current.find((x) => x.id === selected);
        if (m?.type === "polygon" && hitVertex(polyRings(m), imagePoint(pointer, space), pad()))
          return "move";
      }
      if (hover) return "grab";
      if (!drawing && pointer && (!space || !canStartAt(imagePoint(pointer, space))))
        return "not-allowed";
      return latest.current.tool === "point"
        ? 'url("/cursors/point.svg") 12 12, crosshair'
        : 'url("/cursors/polygon.svg") 8 8, crosshair';
    }

    function cursor() {
      if (!brushing()) brushCursor.update(null, space);
      const next = cursorAt();
      if (root.style.cursor !== next) root.style.cursor = next;
    }

    function redraw() {
      if (!ctx) return;
      const job = latest.current.jobs.find((j) => j.id === latest.current.jobId);
      paintScene(ctx, root, marksRef.current, latest.current.jobs, {
        pending: latest.current.pending,
        draft: drawing ? draft : [],
        draftColor: job?.color,
        hoverId: hover,
        selectedId: selected,
        insertAt,
        tool: latest.current.tool,
        brush:
          painting && stroke.length && brushing()
            ? {
                r: latest.current.radius,
                color: job?.color || "#fafafa",
                points: stroke,
                erase: erasing,
              }
            : null,
      });
    }

    function clampView() {
      const img = imgRef.current;
      if (!img?.naturalWidth) return;
      const w = root.clientWidth;
      const h = root.clientHeight;
      const fit = Math.min(w / img.naturalWidth, h / img.naturalHeight);
      const cw = img.naturalWidth * fit;
      const ch = img.naturalHeight * fit;
      const axis = (p: number, origin: number, size: number, limit: number) => {
        const drawn = size * view.z;
        if (drawn <= limit) return limit / 2 - (origin + size / 2) * view.z;
        return Math.min(-origin * view.z, Math.max(limit - (origin + size) * view.z, p));
      };
      view.x = axis(view.x, (w - cw) / 2, cw, w);
      view.y = axis(view.y, (h - ch) / 2, ch, h);
    }

    function applyView() {
      const img = imgRef.current;
      if (!img) return;
      clampView();
      img.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
      space = measureSpace(root);
      ctx = setupCanvas(canvas, root);
      if (drawing && space) {
        draft.length = 0;
        for (const p of stroke) draft.push(imageToScreen(p, space));
      }
      if (!drawing && !painting && !drag) updateHover();
      cursor();
      redraw();
      latest.current.onViewChange?.(space);
    }

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      pointer = e;
      if (e.ctrlKey || e.metaKey) {
        const r = root.getBoundingClientRect();
        const z2 = Math.min(8, Math.max(1, view.z * Math.exp(-e.deltaY * 0.002)));
        const k = z2 / view.z;
        const cx = e.clientX - r.left;
        const cy = e.clientY - r.top;
        view.x = cx - (cx - view.x) * k;
        view.y = cy - (cy - view.y) * k;
        view.z = z2;
      } else if (e.shiftKey && brushing()) {
        const delta = e.deltaY || e.deltaX;
        latest.current.onRadiusChange(
          Math.min(80, Math.max(2, latest.current.radius - Math.sign(delta) * 2)),
        );
        cursor();
        return;
      } else if (view.z > 1) {
        view.x -= e.deltaX;
        view.y -= e.deltaY;
      } else {
        cursor();
        return;
      }
      applyView();
    }

    function hit(e: PointerPosition) {
      if (!space) return null;
      return hitMark(marksRef.current, imagePoint(e, space), space.scale, latest.current.jobId);
    }

    function updateHover() {
      hover = pointer && !brushing() ? hit(pointer) : null;
      insertAt = pointer && !brushing() ? (edgeInsert(pointer, selected)?.point ?? null) : null;
    }

    function sample(e: PointerEvent, final = false) {
      if (!space) return;
      const raw = imagePoint(e, space);
      const img = painting ? raw : clampToImage(raw, space);
      const last = stroke[stroke.length - 1];
      const min = painting || final ? 0 : 2 / space.scale;
      const distance = last ? Math.hypot(img[0] - last[0], img[1] - last[1]) : Infinity;
      if (distance > 0 && distance >= min) {
        stroke.push(img);
        if (!painting) draft.push(imageToScreen(img, space));
      } else if (!painting) {
        draft[draft.length - 1] = imageToScreen(img, space);
      }
    }

    function stampLive() {
      const b = ensureBrush();
      if (!b || stroke.length <= stampedPoints) return;
      const a = stroke.slice(Math.max(0, stampedPoints - 1));
      b.stamp(a, latest.current.radius, erasing);
      stampedPoints = stroke.length;
    }

    function endPaint() {
      if (!painting) return;
      painting = false;
      if (brush && stroke.length) {
        marksRef.current = applyPolys(marksRef.current, brushJobId, brush.toPolygons());
        changed();
      }
      stroke.length = 0;
      draft.length = 0;
    }

    function primed(e: PointerEvent) {
      space = measureSpace(root);
      if (!space) return false;
      ctx = setupCanvas(canvas, root);
      e.preventDefault();
      return true;
    }

    function onDown(e: PointerEvent) {
      pointer = e;
      if (brushing()) {
        if (e.button !== 0 && e.button !== 2) return;
        if (!primed(e) || !space) return;
        if (!brushTouchesImage(imagePoint(e, space), latest.current.radius, space)) {
          cursor();
          return;
        }
        selected = null;
        hover = null;
        painting = true;
        erasing = e.shiftKey || e.button === 2;
        stampedPoints = 0;
        stroke.length = 0;
        draft.length = 0;
        stroke.push(imagePoint(e, space));
        stampLive();
        root.setPointerCapture(e.pointerId);
        cursor();
        redraw();
        return;
      }
      if (e.button !== 0) return;
      if (!primed(e) || !space) return;
      const pt = imagePoint(e, space);
      const id = hit(e);
      if (id) {
        const m = marksRef.current.find((x) => x.id === id);
        const add = selected === id ? edgeInsert(e, id) : null;
        selected = id;
        hover = id;
        const v = m?.type === "polygon" ? hitVertex(polyRings(m), pt, pad()) : null;
        if (add && m) {
          ringOf(m, add.ring)?.splice(add.i + 1, 0, add.point);
          drag = { kind: "vertex", id, ring: add.ring, index: add.i + 1 };
          insertAt = null;
          dirty = true;
        } else if (v) drag = { kind: "vertex", id, ring: v.ring, index: v.index };
        else drag = { kind: "move", id, last: pt };
        root.setPointerCapture(e.pointerId);
        cursor();
        redraw();
        return;
      }
      selected = null;
      hover = null;
      insertAt = null;
      if (!canStartAt(pt)) {
        cursor();
        redraw();
        return;
      }
      if (latest.current.tool === "point" && latest.current.onAiPoint) {
        if (
          latest.current.pending?.some(
            (t) =>
              t.job_id === latest.current.jobId &&
              Math.hypot(t.x - pt[0], t.y - pt[1]) * space!.scale < 12,
          )
        )
          return;
        latest.current.onAiPoint?.(pt);
        return;
      }
      if (latest.current.tool === "point") {
        marksRef.current = [
          ...marksRef.current,
          {
            id: crypto.randomUUID(),
            type: "point",
            points: [pt],
            jobId: latest.current.jobId,
          },
        ];
        selected = marksRef.current.at(-1)?.id ?? null;
        draft.length = 0;
        cursor();
        redraw();
        changed();
        return;
      }
      drawing = true;
      stroke.length = 0;
      draft.length = 0;
      stroke.push(pt);
      draft.push(imageToScreen(pt, space));
      root.setPointerCapture(e.pointerId);
      cursor();
      redraw();
    }

    function onMove(e: PointerEvent) {
      pointer = e;
      if (brushing() && !painting) {
        cursor();
        return;
      }
      if (!drag && !painting && !drawing) space = measureSpace(root);
      const active = drag;
      if (active && space) {
        const now = imagePoint(e, space);
        const m = marksRef.current.find((x) => x.id === active.id);
        if (m && active.kind === "vertex") {
          const ring = ringOf(m, active.ring);
          if (ring) ring[active.index] = clampToImage(now, space);
          dirty = true;
        } else if (m && active.kind === "move") {
          const delta = moveWithinImage(m, now[0] - active.last[0], now[1] - active.last[1], space);
          if (delta) {
            active.last[0] += delta[0];
            active.last[1] += delta[1];
            dirty = true;
          }
        }
        redraw();
        return;
      }
      if (painting || drawing) {
        const events = e.getCoalescedEvents?.();
        for (const ev of events?.length ? events : [e]) sample(ev);
        if (painting) stampLive();
        cursor();
        redraw();
        return;
      }
      const previousHover = hover;
      const previousInsert = insertAt;
      updateHover();
      cursor();
      if (
        hover !== previousHover ||
        insertAt?.[0] !== previousInsert?.[0] ||
        insertAt?.[1] !== previousInsert?.[1]
      )
        redraw();
    }

    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      if (e.key === "Escape") {
        selected = null;
        hover = null;
        insertAt = null;
        cursor();
        redraw();
        return;
      }
      if (e.key === "[" || e.key === "]") {
        latest.current.onRadiusChange(
          Math.min(80, Math.max(2, latest.current.radius + (e.key === "]" ? 2 : -2))),
        );
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (!selected || drawing || drag || painting) return;
      e.preventDefault();
      marksRef.current = marksRef.current.filter((m) => m.id !== selected);
      selected = null;
      hover = null;
      insertAt = null;
      if (brushing()) {
        brush = null;
        ensureBrush();
      }
      cursor();
      redraw();
      changed();
    }

    function release(e: PointerEvent) {
      if (root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
    }

    function finishGesture(e: PointerEvent) {
      if (drag) {
        drag = null;
        updateHover();
        release(e);
        cursor();
        redraw();
        if (dirty) changed();
        dirty = false;
        return;
      }
      if (painting) {
        if (space) {
          sample(e);
          stampLive();
        }
        endPaint();
        release(e);
        cursor();
        redraw();
        return;
      }
      if (!drawing) return;
      drawing = false;
      sample(e, true);
      const points = simplifyPolygon(stroke.slice());
      stroke.length = 0;
      draft.length = 0;
      if (hasPolygonArea(points)) {
        const id = crypto.randomUUID();
        marksRef.current = [
          ...marksRef.current,
          { id, type: "polygon", points, jobId: latest.current.jobId },
        ];
        selected = id;
        changed();
      }
      release(e);
      updateHover();
      cursor();
      redraw();
    }

    function onUp(e: PointerEvent) {
      pointer = e;
      finishGesture(e);
      drain();
    }

    function onLeave() {
      if (drawing || painting || drag) return;
      pointer = null;
      brushCursor.update(null, space);
      const clearHover = !brushing() && (hover !== null || insertAt !== null);
      hover = null;
      insertAt = null;
      root.style.cursor = "";
      if (clearHover) redraw();
    }

    function onMenu(e: Event) {
      if (brushing()) e.preventDefault();
    }

    const ro = new ResizeObserver(() => applyView());
    ro.observe(root);
    cursor();
    root.addEventListener("pointerdown", onDown);
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerup", onUp);
    root.addEventListener("pointercancel", onUp);
    root.addEventListener("pointerleave", onLeave);
    root.addEventListener("contextmenu", onMenu);
    root.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    if (brushing()) ensureBrush();
    redraw();
    return () => {
      ro.disconnect();
      brushCursor.destroy();
      root.style.cursor = "";
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerup", onUp);
      root.removeEventListener("pointercancel", onUp);
      root.removeEventListener("pointerleave", onLeave);
      root.removeEventListener("contextmenu", onMenu);
      root.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, [rootRef, canvasRef, cursorRef, imgRef, marksRef, onChangeRef]);

  useEffect(() => {
    ctl.current.redraw();
  }, [opts.pending]);

  useEffect(() => {
    ctl.current.cursor();
    ctl.current.redraw();
  }, [radius]);

  const prev = useRef<{ tool: Tool; jobId: number } | null>(null);
  useEffect(() => {
    const last = prev.current;
    prev.current = { tool, jobId };
    if (!last) return;
    if (last.tool === "brush" && (tool !== "brush" || last.jobId !== jobId)) ctl.current.flush();
    ctl.current.reset(last.jobId !== jobId);
  }, [tool, jobId]);

  return {
    flush: () => ctl.current.flush(),
    reset: () => ctl.current.reset(),
    add: (marks) => ctl.current.add(marks),
  };
}
