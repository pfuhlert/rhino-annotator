import { useEffect, useRef, type RefObject } from "react";
import type { Job } from "@/lib/api";
import { applyPolys, createBrush, jobPolys, type Brush } from "./brush";
import {
  imagePoint,
  imageToScreen,
  measureSpace,
  paintScene,
  polyRings,
  ringOf,
  screenPoint,
  setupCanvas,
  shiftMark,
  type Mark,
  type Tool,
} from "./draw";
import { hitMark, hitVertex, insertTarget, simplifyPolygon } from "./geometry";
import { isTypingTarget } from "./keys";

type Ctl = { flush: (commit?: boolean) => void; reset: (clearSelect?: boolean) => void };

export function useFreehand(opts: {
  rootRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  imgRef: RefObject<HTMLImageElement | null>;
  tool: Tool;
  jobId: number;
  marksRef: RefObject<Mark[]>;
  jobs: Job[];
  radius: number;
  onRadiusChange: (radius: number) => void;
  onChangeRef: RefObject<(() => void) | undefined>;
}): Ctl {
  const { rootRef, canvasRef, imgRef, tool, jobId, marksRef, onChangeRef, jobs, radius, onRadiusChange } = opts;
  const toolRef = useRef(tool);
  const jobRef = useRef(jobId);
  const jobsRef = useRef(jobs);
  const radiusRef = useRef(radius);
  const onRadiusChangeRef = useRef(onRadiusChange);
  const ctl = useRef({ flush(_?: boolean) {}, reset(_?: boolean) {}, redraw() {} });
  useEffect(() => {
    toolRef.current = tool;
    jobRef.current = jobId;
    jobsRef.current = jobs;
    radiusRef.current = radius;
    onRadiusChangeRef.current = onRadiusChange;
  });

  useEffect(() => {
    if (!rootRef.current || !canvasRef.current) return;
    const root = rootRef.current;
    const canvas = canvasRef.current;
    const view = { z: 1, x: 0, y: 0 };

    let drawing = false;
    let painting = false;
    let erasing = false;
    let brush: Brush | null = null;
    let brushDirty = false;
    let pointer: [number, number] | null = null;
    let space = measureSpace(root);
    let ctx = setupCanvas(canvas, root);
    let selected: string | null = null;
    let hover: string | null = null;
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
      return toolRef.current === "brush";
    }

    function ensureBrush() {
      const img = imgRef.current;
      if (!img?.naturalWidth) return null;
      if (!brush || brush.width !== img.naturalWidth || brush.height !== img.naturalHeight) {
        brush = createBrush(img.naturalWidth, img.naturalHeight);
        brush.enter(jobPolys(marksRef.current, jobRef.current));
        brushDirty = false;
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
      if (clearSelect) {
        selected = null;
        hover = null;
        insertAt = null;
      }
      brush = null;
      brushDirty = false;
      if (brushing()) ensureBrush();
      redraw();
    }

    function commitMask(commit: boolean) {
      const b = ensureBrush();
      if (!b) return;
      marksRef.current = applyPolys(marksRef.current, jobRef.current, b.toPolygons());
      brushDirty = false;
      if (commit) changed();
    }

    function flush(commit = true) {
      if (painting) endPaint();
      else if (brush && brushDirty) commitMask(commit);
      if (commit) cancelGesture();
      redraw();
    }

    ctl.current = { flush, reset, redraw };

    function edgeInsert(e: PointerEvent, id: string | null) {
      if (!space || !id) return null;
      const m = marksRef.current.find((x) => x.id === id);
      if (m?.type !== "polygon") return null;
      return insertTarget(polyRings(m), imagePoint(e, space), space.scale);
    }

    function cursorAt(e?: PointerEvent) {
      if (brushing()) return "none";
      if (drag?.kind === "vertex") return "move";
      if (drag) return "grabbing";
      if (insertAt) return "copy";
      if (e && selected && space) {
        const m = marksRef.current.find((x) => x.id === selected);
        if (m?.type === "polygon" && hitVertex(polyRings(m), imagePoint(e, space), pad())) return "move";
      }
      if (hover) return "grab";
      return "crosshair";
    }

    function cursor(e?: PointerEvent) {
      root.style.cursor = cursorAt(e);
    }

    function redraw() {
      if (!ctx) return;
      const job = jobsRef.current.find((j) => j.id === jobRef.current);
      paintScene(ctx, root, marksRef.current, jobsRef.current, {
        draft: drawing ? draft : [],
        draftColor: job?.color,
        hoverId: hover,
        selectedId: selected,
        insertAt,
        tool: toolRef.current,
        aim:
          brushing() && pointer && (painting || (!drag && !hover && !insertAt))
            ? {
                p: pointer,
                tool: "brush",
                r: radiusRef.current,
                color: job?.color || "#fafafa",
                points: painting && stroke.length ? stroke : undefined,
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
      redraw();
    }

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = root.getBoundingClientRect();
        const z2 = Math.min(8, Math.max(1, view.z * Math.exp(-e.deltaY * 0.002)));
        const k = z2 / view.z;
        const cx = e.clientX - r.left;
        const cy = e.clientY - r.top;
        view.x = cx - (cx - view.x) * k;
        view.y = cy - (cy - view.y) * k;
        view.z = z2;
      } else if (view.z > 1) {
        view.x -= e.deltaX;
        view.y -= e.deltaY;
      } else return;
      applyView();
    }

    function hit(e: PointerEvent) {
      if (!space) return null;
      return hitMark(marksRef.current, imagePoint(e, space), space.scale, jobRef.current);
    }

    function sample(e: PointerEvent) {
      if (!space) return;
      const img = imagePoint(e, space);
      const screen = screenPoint(e, space);
      const last = stroke[stroke.length - 1];
      const min = 2 / space.scale;
      if (!last || Math.hypot(img[0] - last[0], img[1] - last[1]) >= min) {
        stroke.push(img);
        draft.push(screen);
      } else {
        draft[draft.length - 1] = screen;
      }
    }

    function stampLive() {
      const b = ensureBrush();
      if (!b || stroke.length < 1) return;
      const a = stroke.length === 1 ? stroke : stroke.slice(-2);
      b.stamp(a, radiusRef.current, erasing);
      brushDirty = true;
    }

    function endPaint() {
      if (!painting) return;
      painting = false;
      if (stroke.length) commitMask(true);
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
      if (brushing()) {
        if (e.button !== 0 && e.button !== 2) return;
        if (!primed(e) || !space) return;
        selected = null;
        hover = null;
        painting = true;
        erasing = e.shiftKey || e.button === 2;
        stroke.length = 0;
        draft.length = 0;
        pointer = imagePoint(e, space);
        stroke.push(pointer);
        stampLive();
        root.setPointerCapture(e.pointerId);
        cursor(e);
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
        cursor(e);
        redraw();
        return;
      }
      selected = null;
      hover = null;
      if (toolRef.current === "point") {
        marksRef.current = [
          ...marksRef.current,
          { id: crypto.randomUUID(), type: "point", points: [imagePoint(e, space)], jobId: jobRef.current },
        ];
        selected = marksRef.current.at(-1)?.id ?? null;
        draft.length = 0;
        cursor(e);
        redraw();
        changed();
        return;
      }
      drawing = true;
      stroke.length = 0;
      draft.length = 0;
      stroke.push(imagePoint(e, space));
      draft.push(screenPoint(e, space));
      root.setPointerCapture(e.pointerId);
      cursor(e);
      redraw();
    }

    function onMove(e: PointerEvent) {
      if (!drag && !painting && !drawing) space = measureSpace(root);
      if (space) pointer = imagePoint(e, space);
      const active = drag;
      if (active && space) {
        const now = imagePoint(e, space);
        const m = marksRef.current.find((x) => x.id === active.id);
        if (m && active.kind === "vertex") {
          const ring = ringOf(m, active.ring);
          if (ring) ring[active.index] = now;
          dirty = true;
        } else if (m && active.kind === "move") {
          shiftMark(m, now[0] - active.last[0], now[1] - active.last[1]);
          active.last = now;
          dirty = true;
        }
        redraw();
        return;
      }
      if (painting || drawing) {
        for (const ev of e.getCoalescedEvents?.() ?? [e]) sample(ev);
        if (painting) stampLive();
        redraw();
        return;
      }
      hover = brushing() ? null : hit(e);
      const add = brushing() ? null : edgeInsert(e, selected);
      insertAt = add?.point ?? null;
      cursor(e);
      redraw();
    }

    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      if (e.key === "[" || e.key === "]") {
        onRadiusChangeRef.current(
          Math.min(80, Math.max(2, radiusRef.current + (e.key === "]" ? 2 : -2))),
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

    function onUp(e: PointerEvent) {
      if (drag) {
        drag = null;
        release(e);
        cursor(e);
        redraw();
        if (dirty) changed();
        dirty = false;
        return;
      }
      if (painting) {
        if (space) {
          pointer = imagePoint(e, space);
          sample(e);
          stampLive();
        }
        endPaint();
        release(e);
        cursor(e);
        redraw();
        return;
      }
      if (!drawing) return;
      drawing = false;
      sample(e);
      if (space) stroke[stroke.length - 1] = imagePoint(e, space);
      const points = simplifyPolygon(stroke.slice());
      stroke.length = 0;
      draft.length = 0;
      if (points.length >= 3) {
        const id = crypto.randomUUID();
        marksRef.current = [...marksRef.current, { id, type: "polygon", points, jobId: jobRef.current }];
        selected = id;
        changed();
      }
      release(e);
      hover = selected;
      cursor(e);
      redraw();
    }

    function onLeave() {
      if (drawing || painting || drag) return;
      pointer = null;
      hover = null;
      insertAt = null;
      root.style.cursor = "";
      redraw();
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
  }, [rootRef, canvasRef, imgRef, marksRef, onChangeRef]);

  useEffect(() => {
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
    flush: (commit?: boolean) => ctl.current.flush(commit),
    reset: () => ctl.current.reset(),
  };
}
