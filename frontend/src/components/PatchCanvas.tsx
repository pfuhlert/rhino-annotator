"use client";

import { useEffect, useRef } from "react";
import type { Element, Job } from "@/lib/api";
import { withHoles, type Mark, type Tool } from "@/lib/draw";
import { useFreehand } from "@/lib/freehand";
import { createHistory } from "@/lib/history";

type Props = {
  src: string;
  jobId: number;
  jobs: Job[];
  tool: Tool;
  marks?: Element[];
  onReady?: (api: AnnotatorApi) => void;
  onChange?: () => void;
};

export type AnnotatorApi = {
  toElements: () => Element[];
  undo: () => void;
  redo: () => void;
};

export default function PatchCanvas({ src, jobId, jobs, tool, marks, onReady, onChange }: Props) {
  const initial = (marks ?? []).map((m) =>
    withHoles(
      { id: crypto.randomUUID(), type: m.type, points: m.points as [number, number][], jobId: m.jobId },
      m.holes as [number, number][][] | undefined,
    ),
  );
  const marksRef = useRef<Mark[]>(initial);
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const persistRef = useRef(onChange);
  const history = useRef(createHistory(initial)).current;
  useEffect(() => {
    persistRef.current = onChange;
  });
  const commitRef = useRef(() => {
    history.commit(marksRef.current);
    persistRef.current?.();
  });
  const brush = useFreehand({
    rootRef,
    canvasRef,
    imgRef,
    tool,
    jobId,
    marksRef,
    jobs,
    onChangeRef: commitRef,
  });

  function restore(next: Mark[] | null) {
    if (!next) return;
    marksRef.current = next;
    brush.reset();
    persistRef.current?.();
  }

  useEffect(() => {
    onReady?.({
      toElements: () => {
        brush.flush(false);
        return marksRef.current.map(({ type, points, holes, jobId }) => ({ type, points, holes, jobId }));
      },
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
    </div>
  );
}
