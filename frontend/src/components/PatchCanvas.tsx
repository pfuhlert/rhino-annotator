"use client";

import { useEffect, useRef, useState } from "react";
import type { AiPrompt, AiTask, Element, Job, PatchImage, ViewRect } from "@/lib/api";
import { measureSpace, type Mark, type Tool } from "@/lib/draw";
import { useFillOpacity } from "@/lib/fill-opacity";
import { useFreehand } from "@/lib/freehand";
import { createHistory } from "@/lib/history";
import { isLightBackground, measureScaleBar, sampleBehind } from "@/lib/scale-bar";
import { createTileLayer, visibleRect } from "@/lib/tiles";

type Props = {
  image: PatchImage;
  pending?: AiTask[];
  onAiPrompt: (prompt: AiPrompt) => void;
  onRemote?: (elements: Element[]) => void;
  nmPerPixel: number | null;
  jobId: number;
  jobs: Job[];
  tool: Tool;
  radius: number;
  onRadiusChange: (radius: number) => void;
  marks?: Element[];
  onReady?: (api: AnnotatorApi) => void;
  onChange?: () => void;
  onSelect?: (id: string | null) => void;
  onImageError?: () => void;
  onImageLoad?: () => void;
  onVisibleChange?: (view: ViewRect) => void;
  initialView?: ViewRect | null;
};

export type AnnotatorApi = {
  toElements: () => Element[];
  add: (elements: Element[]) => void;
  flush: () => void;
  cancelDraft: () => boolean;
  undo: () => void;
  redo: () => void;
  highlight: (id: string | null) => void;
  select: (id: string) => void;
  remove: (id: string) => void;
  relabel: (id: string, jobId: number) => void;
};

export default function PatchCanvas({
  image,
  pending,
  onAiPrompt,
  onRemote,
  nmPerPixel,
  jobId,
  jobs,
  tool,
  radius,
  onRadiusChange,
  marks,
  onReady,
  onChange,
  onSelect,
  onImageError,
  onImageLoad,
  onVisibleChange,
  initialView,
}: Props) {
  const [initial] = useState(() => structuredClone(marks ?? []));
  const marksRef = useRef<Mark[]>(initial);
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const planeRef = useRef<HTMLDivElement>(null);
  const tileCanvasRef = useRef<HTMLCanvasElement>(null);
  const tilesRef = useRef<ReturnType<typeof createTileLayer> | null>(null);
  const imageEvents = useRef({ onImageLoad, onImageError, onVisibleChange });
  const visibleTimer = useRef(0);
  const cursorRef = useRef<HTMLDivElement>(null);
  const [scaleBar, setScaleBar] = useState<ReturnType<typeof measureScaleBar>>(null);
  const scaleBarRef = useRef(scaleBar);
  const toneTimer = useRef(0);
  const [lightBehindBar, setLightBehindBar] = useState(false);
  const persistRef = useRef(onChange);
  const [history] = useState(() => createHistory(initial));
  useEffect(() => {
    scaleBarRef.current = scaleBar;
    persistRef.current = onChange;
    imageEvents.current = { onImageLoad, onImageError, onVisibleChange };
  });
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !tileCanvasRef.current) return;
    const tiles = createTileLayer(tileCanvasRef.current, root, image, {
      onLoad: () => {
        if (planeRef.current) planeRef.current.dataset.loaded = "true";
        imageEvents.current.onImageLoad?.();
      },
      onError: () => imageEvents.current.onImageError?.(),
      onDraw: () => {
        window.clearTimeout(toneTimer.current);
        toneTimer.current = window.setTimeout(() => {
          const bar = scaleBarRef.current;
          const canvas = tileCanvasRef.current;
          if (!bar || !canvas) return;
          const viewer = root.parentElement ?? root;
          const pixels = sampleBehind(canvas, bar, getComputedStyle(viewer).backgroundColor);
          if (pixels) setLightBehindBar(isLightBackground(pixels));
        }, 100);
      },
    });
    tiles.update(measureSpace(root));
    tilesRef.current = tiles;
    return () => {
      tiles.destroy();
      window.clearTimeout(visibleTimer.current);
      window.clearTimeout(toneTimer.current);
    };
  }, [image]);
  const commitRef = useRef(() => {
    history.commit(marksRef.current);
    persistRef.current?.();
  });
  const fillOpacity = useFillOpacity();
  const brush = useFreehand({
    rootRef,
    pending,
    onAiPrompt,
    onRemote,
    canvasRef,
    cursorRef,
    planeRef,
    tool,
    jobId,
    marksRef,
    jobs,
    radius,
    fillOpacity,
    onRadiusChange,
    onChangeRef: commitRef,
    onSelect,
    initialView,
    onViewChange: (space) => {
      const root = rootRef.current;
      if (!root) return;
      tilesRef.current?.update(space);
      window.clearTimeout(visibleTimer.current);
      visibleTimer.current = window.setTimeout(() => {
        if (space)
          imageEvents.current.onVisibleChange?.(
            visibleRect(space, root.clientWidth, root.clientHeight),
          );
      }, 150);
      const rootRect = root.getBoundingClientRect();
      const controls = root.parentElement?.querySelector("[data-scale-bar-anchor]");
      const controlsTop = (controls?.getBoundingClientRect().top ?? rootRect.bottom) - rootRect.top;
      const next = measureScaleBar(root, nmPerPixel, space, controlsTop);
      setScaleBar((prev) =>
        prev?.x === next?.x &&
        prev?.y === next?.y &&
        prev?.width === next?.width &&
        prev?.label === next?.label
          ? prev
          : next,
      );
    },
  });

  function restore(next: Mark[] | null) {
    if (!next) return;
    marksRef.current = next;
    brush.reset();
    persistRef.current?.();
  }

  useEffect(() => {
    onReady?.({
      add: (elements) => brush.add(elements),
      toElements: () => marksRef.current,
      flush: () => brush.flush(),
      cancelDraft: () => brush.cancelDraft(),
      undo: () => restore(history.undo()),
      redo: () => restore(history.redo()),
      highlight: (id) => brush.highlight(id),
      select: (id) => brush.select(id),
      remove: (id) => brush.remove(id),
      relabel: (id, jobId) => brush.relabel(id, jobId),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bind once; brush/history are ref wrappers
  }, [onReady]);

  return (
    <div
      ref={rootRef}
      data-testid="patch-canvas"
      className="absolute inset-0 touch-none select-none"
    >
      <canvas
        ref={tileCanvasRef}
        data-testid="patch-tiles"
        className="pointer-events-none absolute inset-0"
      />
      {/* Carries the zoom/pan transform and the patch size; tiles are drawn from it. */}
      <div
        ref={planeRef}
        data-image-plane
        data-width={image.width}
        data-height={image.height}
        className="pointer-events-none absolute inset-0 origin-top-left"
      />
      <canvas
        ref={canvasRef}
        data-testid="patch-marks"
        className="pointer-events-none absolute inset-0"
      />
      <div
        ref={cursorRef}
        data-testid="brush-cursor"
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden"
      />
      {scaleBar && (
        <div
          data-testid="scale-bar"
          className={`pointer-events-none absolute z-10 text-center text-xs leading-5 font-medium ${
            lightBehindBar
              ? "text-black drop-shadow-[0_1px_2px_#fff]"
              : "text-white drop-shadow-[0_1px_2px_#000]"
          }`}
          style={{
            left: scaleBar.x,
            top: scaleBar.y,
            width: scaleBar.width,
            transform: "translateY(-100%)",
          }}
        >
          {scaleBar.label}
          <div className="h-2 border-x-2 border-b-2 border-current" />
        </div>
      )}
    </div>
  );
}
