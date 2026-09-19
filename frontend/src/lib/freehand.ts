import { useEffect, type RefObject } from "react";
import type { Job } from "@/lib/api";
import {
  imagePoint,
  measureSpace,
  paintScene,
  screenPoint,
  setupCanvas,
  type Mark,
} from "./draw";
import { hitMark, hitVertex, insertTarget, simplifyPolygon } from "./geometry";

export function useFreehand(
  rootRef: RefObject<HTMLDivElement | null>,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  toolRef: RefObject<"point" | "polygon">,
  jobRef: RefObject<number>,
  marksRef: RefObject<Mark[]>,
  jobsRef: RefObject<Job[]>,
  onChangeRef: RefObject<(() => void) | undefined>,
) {
  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;

    let drawing = false;
    let space = measureSpace(root);
    let ctx = setupCanvas(canvas, root);
    let selected: string | null = null;
    let hover: string | null = null;
    let drag: { kind: "move"; id: string; last: [number, number] } | { kind: "vertex"; id: string; index: number } | null =
      null;
    let insertAt: [number, number] | null = null;
    let dirty = false;
    const stroke: [number, number][] = [];
    const draft: [number, number][] = [];

    function changed() {
      onChangeRef.current?.();
    }

    function focus() {
      return drag?.id || selected || hover;
    }

    function pad() {
      return space ? 18 / space.scale : 18;
    }

    function edgeInsert(e: PointerEvent, id: string | null) {
      if (!space || !id) return null;
      const m = marksRef.current.find((x) => x.id === id);
      if (m?.type !== "polygon") return null;
      return insertTarget(m.points, imagePoint(e, space), space.scale);
    }

    function cursorAt(e?: PointerEvent) {
      if (drag?.kind === "vertex") return "move";
      if (drag) return "grabbing";
      if (insertAt) return "copy";
      if (e && selected && space) {
        const m = marksRef.current.find((x) => x.id === selected);
        if (m?.type === "polygon" && hitVertex(m.points, imagePoint(e, space), pad()) != null) return "move";
      }
      if (hover) return "grab";
      return "crosshair";
    }

    function cursor(e?: PointerEvent) {
      root.style.cursor = cursorAt(e);
    }

    function redraw() {
      if (!ctx) return;
      paintScene(ctx, root, marksRef.current, draft, jobsRef.current, focus(), selected, insertAt);
    }

    function hit(e: PointerEvent) {
      if (!space) return null;
      return hitMark(marksRef.current, imagePoint(e, space), space.scale);
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

    function onDown(e: PointerEvent) {
      if (e.button !== 0) return;
      space = measureSpace(root);
      if (!space) return;
      ctx = setupCanvas(canvas, root);
      e.preventDefault();
      const pt = imagePoint(e, space);
      const id = hit(e);
      if (id) {
        const m = marksRef.current.find((x) => x.id === id);
        const add = selected === id ? edgeInsert(e, id) : null;
        selected = id;
        hover = id;
        const v = m?.type === "polygon" ? hitVertex(m.points, pt, pad()) : null;
        if (add && m) {
          m.points.splice(add.i + 1, 0, add.point);
          drag = { kind: "vertex", id, index: add.i + 1 };
          insertAt = null;
          dirty = true;
        } else if (v != null) drag = { kind: "vertex", id, index: v };
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
      if (drag && space) {
        const now = imagePoint(e, space);
        const m = marksRef.current.find((x) => x.id === drag.id);
        if (m && drag.kind === "vertex") {
          m.points[drag.index] = now;
          dirty = true;
        } else if (m && drag.kind === "move") {
          const dx = now[0] - drag.last[0];
          const dy = now[1] - drag.last[1];
          drag.last = now;
          m.points = m.points.map(([x, y]) => [x + dx, y + dy]);
          dirty = true;
        }
        redraw();
        return;
      }
      if (drawing) {
        for (const ev of e.getCoalescedEvents?.() ?? [e]) sample(ev);
        redraw();
        return;
      }
      space = measureSpace(root);
      hover = hit(e);
      const add = edgeInsert(e, selected);
      insertAt = add?.point ?? null;
      cursor(e);
      redraw();
    }

    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (!selected || drawing || drag) return;
      e.preventDefault();
      marksRef.current = marksRef.current.filter((m) => m.id !== selected);
      selected = null;
      hover = null;
      insertAt = null;
      cursor();
      redraw();
      changed();
    }

    function onUp(e: PointerEvent) {
      if (drag) {
        drag = null;
        if (root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
        cursor(e);
        redraw();
        if (dirty) changed();
        dirty = false;
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
      if (root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
      hover = selected;
      cursor(e);
      redraw();
    }

    const ro = new ResizeObserver(() => {
      ctx = setupCanvas(canvas, root);
      redraw();
    });
    ro.observe(root);
    root.style.cursor = "crosshair";
    root.addEventListener("pointerdown", onDown);
    root.addEventListener("pointermove", onMove);
    root.addEventListener("pointerup", onUp);
    root.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      ro.disconnect();
      root.style.cursor = "";
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerup", onUp);
      root.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [rootRef, canvasRef, toolRef, jobRef, marksRef, jobsRef, onChangeRef]);
}
