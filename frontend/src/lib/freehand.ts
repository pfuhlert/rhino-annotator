import { useEffect, useRef, type RefObject } from "react";
import type { AiPrompt, AiTask, Job, ViewRect } from "@/lib/api";
import {
  applyPolys,
  BRUSH_MAX,
  BRUSH_MIN,
  BRUSH_STEP,
  createBrush,
  jobPolys,
  type Brush,
} from "./brush";
import { createBrushCursor } from "./brush-cursor";
import type { ViewAction } from "./viewer-keys";
import { scrollZoomFactor, wheelZoomFactor } from "./wheel-zoom";
import { TOOL_CURSORS } from "./tool-cursors";
import {
  imagePoint,
  imageToScreen,
  measureSpace,
  planeSize,
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
  imageBox,
  insideImageBounds,
  insidePixelBounds,
  moveVertex,
  moveWithinImage,
} from "./image-bounds";
import { isTypingTarget } from "./keys";
import { fitView } from "./share-link";

type Ctl = {
  flush: () => void;
  cancelDraft: () => boolean;
  reset: (clearSelect?: boolean) => void;
  add: (marks: Mark[]) => void;
  highlight: (id: string | null) => void;
  select: (id: string) => void;
  remove: (id: string) => void;
  relabel: (id: string, jobId: number) => void;
  navigate: (action: ViewAction) => void;
};

export function useFreehand(opts: {
  rootRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  cursorRef: RefObject<HTMLDivElement | null>;
  planeRef: RefObject<HTMLElement | null>;
  tool: Tool;
  jobId: number;
  marksRef: RefObject<Mark[]>;
  jobs: Job[];
  radius: number;
  fillOpacity: number;
  onRadiusChange: (radius: number) => void;
  onChangeRef: RefObject<(() => void) | undefined>;
  pending?: AiTask[];
  onAiPrompt: (prompt: AiPrompt) => void;
  onRemote?: (marks: Mark[]) => void;
  onViewChange?: (space: Space | null) => void;
  onSelect?: (id: string | null) => void;
  // Patch-pixel rectangle to show first instead of the whole patch.
  initialView?: ViewRect | null;
}): Ctl {
  const { rootRef, canvasRef, cursorRef, planeRef, tool, jobId, marksRef, onChangeRef, radius } =
    opts;
  const latest = useRef(opts);
  useEffect(() => {
    latest.current = opts;
  });
  const ctl = useRef<Ctl & { redraw: () => void; cursor: () => void }>({
    flush() {},
    cancelDraft: () => false,
    reset() {},
    redraw() {},
    cursor() {},
    add() {},
    highlight() {},
    select() {},
    remove() {},
    relabel() {},
    navigate() {},
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
    let boxDrag: {
      start: [number, number];
      end: [number, number];
      pointerId: number;
      submit: (prompt: AiPrompt) => void;
    } | null = null;
    let painting = false;
    let erasing = false;
    // Image-space radius, fixed when a stroke starts so zooming mid-stroke cannot change its width.
    let strokeRadius = 0;
    let brush: Brush | null = null;
    let brushJobId = latest.current.jobId;
    let stampedPoints = 0;
    let space = measureSpace(root);
    let ctx = setupCanvas(canvas, root);
    let selected: string | null = null;
    let reportedSelected: string | null = null;
    let hover: string | null = null;
    // Set from the sidebar. Kept apart from `hover` so canvas pointer events cannot clobber it.
    let listHover: string | null = null;
    let pointer: PointerPosition | null = null;
    let drag:
      | { kind: "move"; id: string; last: [number, number] }
      | { kind: "vertex"; id: string; ring: number; index: number }
      | null = null;
    let insertAt: [number, number] | null = null;
    // Middle-drag, Hand-tool drag, and Space+drag pan the view; `buttons` is the held-button mask.
    let pan: { pointerId: number; buttons: number; x: number; y: number } | null = null;
    // A Hand-tool press that may still turn out to be a click, which zooms.
    let press: { x: number; y: number; at: number } | null = null;
    let spaceHeld = false;
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

    function hand() {
      return latest.current.tool === "hand";
    }

    function ensureBrush() {
      const size = planeSize(planeRef.current);
      if (!size) return null;
      if (!brush || brush.width !== size[0] || brush.height !== size[1]) {
        brush = createBrush(size[0], size[1]);
        brushJobId = latest.current.jobId;
        brush.enter(jobPolys(marksRef.current, brushJobId));
      }
      return brush;
    }

    function cancelGesture() {
      const box = boxDrag;
      boxDrag = null;
      if (box && root.hasPointerCapture(box.pointerId)) root.releasePointerCapture(box.pointerId);
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
      if (drawing || boxDrag || painting || drag || !incoming.length) return;
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
        // Marks drawn here since are not in `seen` but must not come back twice.
        if (seen.has(mark.id) || marksRef.current.some((m) => m.id === mark.id)) continue;
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

    function cancelDraft() {
      if (!boxDrag) return false;
      cancelGesture();
      drain();
      cursor();
      redraw();
      return true;
    }

    function busy() {
      return drawing || !!boxDrag || painting || !!drag;
    }

    function highlight(id: string | null) {
      if (listHover === id) return;
      listHover = id;
      redraw();
    }

    // Brush mode has no selection, but still brings the mark into view.
    function select(id: string) {
      const mark = marksRef.current.find((m) => m.id === id);
      if (busy() || !mark) return;
      if (!brushing()) selected = id;
      if (space && revealMark(mark, space)) return applyView();
      cursor();
      redraw();
    }

    // Pans an off-screen or partly hidden mark to the center, keeping the zoom.
    function revealMark(mark: Mark, s: Space) {
      const xs = mark.points.map((p) => imageToScreen(p, s));
      const [x0, x1] = [Math.min(...xs.map((p) => p[0])), Math.max(...xs.map((p) => p[0]))];
      const [y0, y1] = [Math.min(...xs.map((p) => p[1])), Math.max(...xs.map((p) => p[1]))];
      if (x0 >= 0 && y0 >= 0 && x1 <= root.clientWidth && y1 <= root.clientHeight) return false;
      view.x += root.clientWidth / 2 - (x0 + x1) / 2;
      view.y += root.clientHeight / 2 - (y0 + y1) / 2;
      return true;
    }

    function remove(id: string) {
      if (busy()) return;
      marksRef.current = marksRef.current.filter((m) => m.id !== id);
      if (selected === id) selected = null;
      if (listHover === id) listHover = null;
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

    // Moves an annotation to another label class, keeping its id and shape.
    function relabel(id: string, jobId: number) {
      if (busy()) return;
      marksRef.current = marksRef.current.map((m) => (m.id === id ? { ...m, jobId } : m));
      if (brushing()) {
        brush = null;
        ensureBrush();
      }
      redraw();
      changed();
    }

    ctl.current = {
      flush,
      cancelDraft,
      reset,
      redraw,
      cursor,
      add,
      highlight,
      select,
      remove,
      relabel,
      navigate,
    };

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

    // The radius is in screen pixels, so the brush keeps its on-screen size at every zoom;
    // below 2 image pixels the stroke outline degenerates, so it stops shrinking there.
    function brushRadius(s: Space) {
      return Math.max(2, latest.current.radius / s.scale);
    }

    function resizeBrush(steps: number) {
      const next = latest.current.radius + steps * BRUSH_STEP;
      latest.current.onRadiusChange(Math.min(BRUSH_MAX, Math.max(BRUSH_MIN, next)));
    }

    function cursorAt() {
      if (pan) return "grabbing";
      const tool = latest.current.tool;
      if (tool === "hand" || (spaceHeld && !busy())) return "grab";
      if (tool === "brush")
        return brushCursor.update(
          pointer,
          space,
          space ? (painting ? strokeRadius : brushRadius(space)) * space.scale : null,
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
      if (!drawing && !boxDrag && pointer && (!space || !canStartAt(imagePoint(pointer, space))))
        return "not-allowed";
      return TOOL_CURSORS[tool];
    }

    function cursor() {
      if (!brushing() || pan || spaceHeld) brushCursor.update(null, space);
      const next = cursorAt();
      if (root.style.cursor !== next) root.style.cursor = next;
    }

    function redraw() {
      if (selected !== reportedSelected) {
        reportedSelected = selected;
        latest.current.onSelect?.(selected);
      }
      if (!ctx) return;
      const job = latest.current.jobs.find((j) => j.id === latest.current.jobId);
      paintScene(ctx, root, marksRef.current, latest.current.jobs, {
        pending: latest.current.pending,
        box: boxDrag && space ? imageBox(boxDrag.start, boxDrag.end, space) : null,
        draft: drawing ? draft : [],
        draftColor: job?.color,
        hoverId: hover ?? listHover,
        selectedId: selected,
        insertAt,
        tool: latest.current.tool,
        fillOpacity: latest.current.fillOpacity,
        brush:
          painting && stroke.length && brushing()
            ? {
                r: strokeRadius,
                color: job?.color || "#fafafa",
                points: stroke,
                erase: erasing,
              }
            : null,
      });
    }

    function clampView() {
      const size = planeSize(planeRef.current);
      if (!size) return;
      const w = root.clientWidth;
      const h = root.clientHeight;
      const fit = Math.min(w / size[0], h / size[1]);
      const cw = size[0] * fit;
      const ch = size[1] * fit;
      const axis = (p: number, origin: number, size: number, limit: number) => {
        const drawn = size * view.z;
        if (drawn <= limit) return limit / 2 - (origin + size / 2) * view.z;
        return Math.min(-origin * view.z, Math.max(limit - (origin + size) * view.z, p));
      };
      view.x = axis(view.x, (w - cw) / 2, cw, w);
      view.y = axis(view.y, (h - ch) / 2, ch, h);
    }

    // Large tissue regions need more than the default 8x to reach full resolution.
    function maxZoom() {
      const size = planeSize(planeRef.current);
      if (!size) return 8;
      const fit = Math.min(root.clientWidth / size[0], root.clientHeight / size[1]);
      return Math.max(8, 2 / fit);
    }

    function applyView() {
      const plane = planeRef.current;
      if (!plane) return;
      clampView();
      plane.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
      space = measureSpace(root);
      ctx = setupCanvas(canvas, root);
      if (drawing && space) {
        draft.length = 0;
        for (const p of stroke) draft.push(imageToScreen(p, space));
      }
      if (!drawing && !boxDrag && !painting && !drag) updateHover();
      cursor();
      redraw();
      latest.current.onViewChange?.(space);
    }

    // Zooms about a point given in root coordinates.
    function zoom(factor: number, cx: number, cy: number) {
      const z2 = Math.min(maxZoom(), Math.max(1, view.z * factor));
      const k = z2 / view.z;
      view.x = cx - (cx - view.x) * k;
      view.y = cy - (cy - view.y) * k;
      view.z = z2;
    }

    // Wheel and pointer input can arrive several times per frame; render the view once per frame.
    let viewFrame = 0;
    function scheduleView() {
      if (!viewFrame)
        viewFrame = requestAnimationFrame(() => {
          viewFrame = 0;
          applyView();
        });
    }

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      pointer = e;
      const pinch = e.ctrlKey || e.metaKey;
      if (e.shiftKey && !pinch && brushing()) {
        const delta = e.deltaY || e.deltaX;
        resizeBrush(-Math.sign(delta));
        cursor();
        return;
      }
      zoomAt(e, (pinch ? wheelZoomFactor : scrollZoomFactor)(e.deltaY, e.deltaMode));
    }

    function zoomAt(e: PointerPosition, factor: number) {
      const r = root.getBoundingClientRect();
      zoom(factor, e.clientX - r.left, e.clientY - r.top);
      clampView();
      scheduleView();
    }

    function navigate(action: ViewAction) {
      if (action === "home") {
        Object.assign(view, { z: 1, x: 0, y: 0 });
      } else if ("zoom" in action) {
        zoom(action.zoom, root.clientWidth / 2, root.clientHeight / 2);
      } else {
        view.x -= action.pan[0];
        view.y -= action.pan[1];
      }
      clampView();
      scheduleView();
    }

    // Ctrl/⌘+scroll elsewhere (sidebar, toolbar) would zoom the browser page; zoom the image instead.
    function onPageWheel(e: WheelEvent) {
      if (!(e.ctrlKey || e.metaKey) || root.contains(e.target as Node)) return;
      e.preventDefault();
      navigate({ zoom: wheelZoomFactor(e.deltaY, e.deltaMode) });
    }

    function hit(e: PointerPosition) {
      if (!space) return null;
      return hitMark(marksRef.current, imagePoint(e, space), space.scale, latest.current.jobId);
    }

    function updateHover() {
      const at = brushing() || hand() || spaceHeld || pan ? null : pointer;
      hover = at ? hit(at) : null;
      insertAt = at ? (edgeInsert(at, selected)?.point ?? null) : null;
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
      b.stamp(a, strokeRadius, erasing);
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
      if (e.button === 1 || (e.button === 0 && (hand() || spaceHeld))) {
        e.preventDefault();
        if (busy() || pan) return;
        pan = {
          pointerId: e.pointerId,
          buttons: e.button === 1 ? 4 : 1,
          x: e.clientX,
          y: e.clientY,
        };
        press =
          e.button === 0 && hand() && !spaceHeld
            ? { x: e.clientX, y: e.clientY, at: e.timeStamp }
            : null;
        root.setPointerCapture(e.pointerId);
        cursor();
        return;
      }
      if (boxDrag || pan || hand() || spaceHeld) return;
      pointer = e;
      if (brushing()) {
        if (e.button !== 0 && e.button !== 2) return;
        if (!primed(e) || !space) return;
        strokeRadius = brushRadius(space);
        if (!brushTouchesImage(imagePoint(e, space), strokeRadius, space)) {
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
      if (latest.current.tool === "point") {
        if (
          latest.current.pending?.some(
            (t) =>
              !t.box &&
              t.job_id === latest.current.jobId &&
              Math.hypot(t.x - pt[0], t.y - pt[1]) * space!.scale < 12,
          )
        )
          return;
        latest.current.onAiPrompt({ x: pt[0], y: pt[1] });
        return;
      }
      if (latest.current.tool === "ai-box") {
        const submit = latest.current.onAiPrompt;
        boxDrag = { start: pt, end: pt, pointerId: e.pointerId, submit };
        root.setPointerCapture(e.pointerId);
        cursor();
        redraw();
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
      if (pan) {
        if (e.pointerId !== pan.pointerId) return;
        if ((e.buttons & pan.buttons) === 0) return finishGesture(e);
        view.x += e.clientX - pan.x;
        view.y += e.clientY - pan.y;
        pan.x = e.clientX;
        pan.y = e.clientY;
        clampView();
        scheduleView();
        return;
      }
      if (boxDrag && space) {
        if (e.pointerId !== boxDrag.pointerId) return;
        boxDrag.end = clampToImage(imagePoint(e, space), space);
        cursor();
        redraw();
        return;
      }
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
          if (ring) ring[active.index] = moveVertex(ring[active.index], now, space);
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

    function holdSpace(held: boolean) {
      if (spaceHeld === held) return;
      spaceHeld = held;
      if (!busy()) updateHover();
      cursor();
      redraw();
    }

    // Capture phase so the canvas sees Space first; it only swallows the key over the image,
    // so a focused button or menu trigger elsewhere still gets it.
    function onSpaceDown(e: KeyboardEvent) {
      if (e.key !== " " || isTypingTarget(e.target)) return;
      if (pointer) {
        e.preventDefault();
        e.stopPropagation();
      }
      holdSpace(true);
    }

    function onKeyUp(e: KeyboardEvent) {
      if (e.key === " ") holdSpace(false);
    }

    function onKey(e: KeyboardEvent) {
      // A dialog closing on Escape marks it handled.
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      if (e.key === "Escape") {
        selected = null;
        hover = null;
        insertAt = null;
        cursor();
        redraw();
        return;
      }
      if (e.key === "[" || e.key === "]") {
        resizeBrush(e.key === "]" ? 1 : -1);
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (!selected || busy()) return;
      e.preventDefault();
      remove(selected);
    }

    function release(e: PointerEvent) {
      if (root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
    }

    function finishGesture(e: PointerEvent) {
      if (pan) {
        if (e.pointerId !== pan.pointerId) return;
        pan = null;
        release(e);
        cursor();
        // OpenSeadragon's click: within 5 px and 300 ms, Shift zooms out.
        if (
          press &&
          e.type === "pointerup" &&
          e.timeStamp - press.at <= 300 &&
          Math.hypot(e.clientX - press.x, e.clientY - press.y) <= 5
        )
          zoomAt(e, e.shiftKey ? 0.5 : 2);
        press = null;
        return;
      }
      if (boxDrag) {
        if (e.pointerId !== boxDrag.pointerId) return;
        const gesture = boxDrag;
        boxDrag = null;
        if (space && e.type !== "pointercancel") {
          const end = clampToImage(imagePoint(e, space), space);
          const box = imageBox(gesture.start, end, space);
          if (box && (box[2] - box[0]) * space.scale >= 3 && (box[3] - box[1]) * space.scale >= 3)
            gesture.submit({ box });
        }
        release(e);
        updateHover();
        cursor();
        redraw();
        return;
      }
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
      if (drawing || boxDrag || painting || drag || pan) return;
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

    const size = planeSize(planeRef.current);
    const initial = latest.current.initialView;
    if (initial && size) {
      Object.assign(view, fitView(initial, size, [root.clientWidth, root.clientHeight], maxZoom()));
      applyView();
    }
    const ro = new ResizeObserver(() => applyView());
    ro.observe(root);
    cursor();
    root.addEventListener("pointerdown", onDown);
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerup", onUp);
    root.addEventListener("pointercancel", onUp);
    root.addEventListener("lostpointercapture", cancelDraft);
    root.addEventListener("pointerleave", onLeave);
    root.addEventListener("contextmenu", onMenu);
    root.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("wheel", onPageWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    window.addEventListener("keydown", onSpaceDown, true);
    window.addEventListener("keyup", onKeyUp);
    const releaseSpace = () => holdSpace(false);
    window.addEventListener("blur", releaseSpace);
    if (brushing()) ensureBrush();
    redraw();
    return () => {
      ro.disconnect();
      cancelAnimationFrame(viewFrame);
      brushCursor.destroy();
      root.style.cursor = "";
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerup", onUp);
      root.removeEventListener("pointercancel", onUp);
      root.removeEventListener("lostpointercapture", cancelDraft);
      root.removeEventListener("pointerleave", onLeave);
      root.removeEventListener("contextmenu", onMenu);
      root.removeEventListener("wheel", onWheel);
      window.removeEventListener("wheel", onPageWheel);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", onSpaceDown, true);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseSpace);
    };
  }, [rootRef, canvasRef, cursorRef, planeRef, marksRef, onChangeRef]);

  useEffect(() => {
    ctl.current.redraw();
  }, [opts.pending, opts.fillOpacity, opts.jobs]);

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
    ctl.current.reset(last.jobId !== jobId || tool === "brush" || tool === "hand");
  }, [tool, jobId]);

  return {
    flush: () => ctl.current.flush(),
    cancelDraft: () => ctl.current.cancelDraft(),
    reset: () => ctl.current.reset(),
    add: (marks) => ctl.current.add(marks),
    highlight: (id) => ctl.current.highlight(id),
    select: (id) => ctl.current.select(id),
    remove: (id) => ctl.current.remove(id),
    relabel: (id, jobId) => ctl.current.relabel(id, jobId),
    navigate: (action) => ctl.current.navigate(action),
  };
}
