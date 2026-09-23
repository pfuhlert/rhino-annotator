"use client";

import { useEffect, useRef, useState } from "react";
import type { AiTask, Element, Job } from "@/lib/api";
import { type Mark, type Tool } from "@/lib/draw";
import { useFreehand } from "@/lib/freehand";
import { createHistory } from "@/lib/history";
import { measureScaleBar } from "@/lib/scale-bar";

type Props = {
  src: string;
  pending?: AiTask[];
  onAiPoint?: (point: [number, number]) => void;
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
};

export type AnnotatorApi = {
  toElements: () => Element[];
  add: (elements: Element[]) => void;
  flush: () => void;
  undo: () => void;
  redo: () => void;
};

export default function PatchCanvas({
  src,
  pending,
  onAiPoint,
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
}: Props) {
  const [initial] = useState(() => structuredClone(marks ?? []));
  const marksRef = useRef<Mark[]>(initial);
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [scaleBar, setScaleBar] = useState<ReturnType<typeof measureScaleBar>>(null);
  const persistRef = useRef(onChange);
  const [history] = useState(() => createHistory(initial));
  useEffect(() => {
    persistRef.current = onChange;
  });
  const commitRef = useRef(() => {
    history.commit(marksRef.current);
    persistRef.current?.();
  });
  const brush = useFreehand({
    rootRef,
    pending,
    onAiPoint,
    onRemote,
    canvasRef,
    imgRef,
    tool,
    jobId,
    marksRef,
    jobs,
    radius,
    onRadiusChange,
    onChangeRef: commitRef,
    onViewChange: (space) => {
      if (!rootRef.current) return;
      const next = measureScaleBar(rootRef.current, nmPerPixel, space);
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
      undo: () => restore(history.undo()),
      redo: () => restore(history.redo()),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bind once; brush/history are ref wrappers
  }, [onReady]);

  return (
    <div
      ref={rootRef}
      data-testid="patch-canvas"
      className="absolute inset-0 touch-none select-none"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={imgRef}
        alt="patch"
        src={src}
        className="h-full w-full origin-top-left object-contain select-none"
        draggable={false}
        onLoad={() => brush.reset()}
      />
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0" />
      {scaleBar && (
        <div
          data-testid="scale-bar"
          className="pointer-events-none absolute z-10 text-center text-xs leading-5 font-medium text-white drop-shadow-[0_1px_2px_#000]"
          style={{
            left: scaleBar.x,
            top: scaleBar.y,
            width: scaleBar.width,
            transform: "translateY(-100%)",
          }}
        >
          {scaleBar.label}
          <div className="h-2 border-x-2 border-b-2 border-white" />
        </div>
      )}
    </div>
  );
}
