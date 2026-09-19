"use client";

import { useEffect, useRef } from "react";
import type { Element, Job } from "@/lib/api";
import { paintScene, setupCanvas, type Mark } from "@/lib/draw";
import { useFreehand } from "@/lib/freehand";
import { createHistory } from "@/lib/history";

type Props = {
  src: string;
  jobId: number;
  jobs: Job[];
  tool: "point" | "polygon";
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
  const jobRef = useRef(jobId);
  const toolRef = useRef(tool);
  const jobsRef = useRef(jobs);
  const marksRef = useRef<Mark[]>(
    (marks ?? []).map((m) => ({
      id: crypto.randomUUID(),
      type: m.type,
      points: m.points as [number, number][],
      jobId: m.jobId,
    })),
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const persistRef = useRef(onChange);
  const history = useRef(createHistory(marksRef.current)).current;
  const commitRef = useRef(() => {
    history.commit(marksRef.current);
    persistRef.current?.();
  });

  useEffect(() => {
    jobRef.current = jobId;
    toolRef.current = tool;
    jobsRef.current = jobs;
    persistRef.current = onChange;
  }, [jobId, tool, jobs, onChange]);

  function paint() {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    const ctx = setupCanvas(canvas, root);
    if (ctx) paintScene(ctx, root, marksRef.current, [], jobsRef.current);
  }

  function restore(next: Mark[] | null) {
    if (!next) return;
    marksRef.current = next;
    paint();
    persistRef.current?.();
  }

  useEffect(() => {
    onReady?.({
      toElements: () =>
        marksRef.current.map(({ type, points, jobId }) => ({ type, points, jobId })),
      undo: () => restore(history.undo()),
      redo: () => restore(history.redo()),
    });
  }, [onReady]);

  useFreehand(rootRef, canvasRef, toolRef, jobRef, marksRef, jobsRef, commitRef);

  return (
    <div
      ref={rootRef}
      data-testid="patch-canvas"
      className="absolute inset-0 touch-none select-none"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt="patch"
        src={src}
        className="h-full w-full object-contain select-none"
        draggable={false}
        onLoad={paint}
      />
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0" />
    </div>
  );
}
