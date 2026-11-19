"use client";

import { cn } from "cn";
import { useRef, useState } from "react";
import { Kbd } from "@/components/Toolbar";
import type { Job, ScoreValue, Scores } from "@/lib/api";
import { scoreLabel } from "@/lib/scores";

// Hovering previews a score and dragging moves the handle; releasing the pointer saves, so a pick
// is one save instead of one per move.
type Preview = { value: number; held: boolean };

function ScoreSlider({
  job,
  value,
  onCommit,
}: {
  job: Job;
  value: ScoreValue | undefined;
  onCommit: (value: number) => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const saved = typeof value === "number" ? value : null;
  const score = preview?.held ? preview.value : saved;
  const hover = preview && !preview.held && preview.value !== saved ? preview.value : null;
  const at = (e: React.PointerEvent) => {
    const r = track.current!.getBoundingClientRect();
    return Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 100);
  };
  return (
    <div
      data-testid={`score-slider-${job.name}`}
      role="slider"
      tabIndex={-1}
      aria-label={`${job.name} score`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={score ?? undefined}
      aria-valuetext={value === "na" ? "Not scorable" : (score?.toString() ?? "Not scored")}
      className="group relative flex h-8 w-[min(22rem,40vw)] cursor-pointer touch-none items-center px-2 select-none"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        setPreview({ value: at(e), held: true });
      }}
      onPointerMove={(e) =>
        setPreview({ value: at(e), held: e.currentTarget.hasPointerCapture(e.pointerId) })
      }
      onPointerUp={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        onCommit(at(e));
        setPreview(null);
      }}
      onPointerCancel={() => setPreview(null)}
      onPointerLeave={(e) => !e.currentTarget.hasPointerCapture(e.pointerId) && setPreview(null)}
    >
      <div ref={track} className="relative h-1.5 w-full rounded-full bg-black/10 dark:bg-white/15">
        {[0, 25, 50, 75, 100].map((tick) => (
          <span
            key={tick}
            className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-black/20 dark:bg-white/25"
            style={{ left: `${tick}%` }}
          />
        ))}
        {score !== null && (
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${score}%`, background: job.color }}
          />
        )}
        {hover !== null && (
          <div
            data-testid="score-preview"
            className="absolute top-1/2 size-4 -translate-1/2 rounded-full border-2 bg-white opacity-60 dark:bg-neutral-900"
            style={{ left: `${hover}%`, borderColor: job.color }}
          />
        )}
        {score !== null && (
          <div
            className="absolute top-1/2 size-4 -translate-1/2 rounded-full border-2 bg-white shadow-md transition-transform group-active:scale-110 dark:bg-neutral-900"
            style={{ left: `${score}%`, borderColor: job.color }}
          />
        )}
      </div>
      {preview && (
        <span
          className="pointer-events-none absolute -top-5 text-xs font-medium tabular-nums text-neutral-500 dark:text-neutral-400"
          style={{
            left: `calc(0.5rem + (100% - 1rem) * ${preview.value / 100})`,
            transform: "translateX(-50%)",
          }}
        >
          {preview.value}
        </span>
      )}
    </div>
  );
}

// One row per score class of the project; keys score the active row.
export default function ScoreDock({
  jobs,
  scores,
  activeId,
  onActivate,
  onScore,
}: {
  jobs: Job[];
  scores: Scores;
  activeId: number;
  onActivate: (id: number) => void;
  onScore: (id: number, value: ScoreValue | null) => void;
}) {
  return (
    <div
      data-testid="score-dock"
      className="pointer-events-auto mx-auto mb-2 flex w-fit flex-col gap-0.5 rounded-2xl border border-black/10 bg-white/85 p-1.5 text-sm text-neutral-800 shadow-lg shadow-black/10 backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/80 dark:text-neutral-100 dark:shadow-black/30"
    >
      {jobs.map((job) => {
        const value = scores[job.id];
        const active = job.id === activeId && jobs.length > 1;
        const na = value === "na";
        return (
          <div
            key={job.id}
            data-testid={`score-row-${job.name}`}
            aria-current={job.id === activeId}
            className={cn(
              "flex items-center gap-2 rounded-xl py-0.5 pr-1 pl-2",
              active && "bg-black/5 dark:bg-white/10",
            )}
            onPointerDown={() => onActivate(job.id)}
          >
            <span className="flex w-32 min-w-0 items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: job.color }} />
              <span className="truncate font-medium" title={job.name}>
                {job.name}
              </span>
            </span>
            <button
              type="button"
              data-testid={`score-na-${job.name}`}
              aria-pressed={na}
              title="Not scorable (X)"
              className={cn(
                "h-7 rounded-full border px-2.5 text-xs",
                na
                  ? "border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-300"
                  : "border-black/10 text-neutral-600 hover:bg-black/5 dark:border-white/15 dark:text-neutral-300 dark:hover:bg-white/10",
              )}
              onClick={() => onScore(job.id, na ? null : "na")}
            >
              N/A
            </button>
            <span className="text-xs text-neutral-500 tabular-nums dark:text-neutral-400">0</span>
            <ScoreSlider job={job} value={value} onCommit={(v) => onScore(job.id, v)} />
            <span className="text-xs text-neutral-500 tabular-nums dark:text-neutral-400">100</span>
            <output
              data-testid={`score-value-${job.name}`}
              className={cn(
                "w-11 text-center text-lg font-semibold tabular-nums",
                value === undefined && "text-neutral-400 dark:text-neutral-500",
                na && "text-sm text-amber-700 dark:text-amber-300",
              )}
            >
              {scoreLabel(value)}
            </output>
          </div>
        );
      })}
      <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 px-2 pt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
        <span>
          <Kbd>0–9</Kbd> score
        </span>
        <span>
          <Kbd>X</Kbd> not scorable
        </span>
        {jobs.length > 1 && (
          <span>
            <Kbd>S</Kbd> next score
          </span>
        )}
        <span>
          <Kbd>↵</Kbd> next image
        </span>
      </p>
    </div>
  );
}
