"use client";

import { cn } from "cn";
import type { Job } from "@/lib/api";
import { type EditorMode, structureKeyLabel } from "@/lib/structures";

const pill =
  "pointer-events-auto flex items-center gap-1 rounded-full border border-black/10 bg-white/85 p-1 text-sm text-neutral-800 shadow-lg shadow-black/10 backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/80 dark:text-neutral-100 dark:shadow-black/30";

// The top of the editor: the Masks / Scores switch, and in the Masks view every structure with the
// number key that picks it.
export default function StructureBar({
  mode,
  onMode,
  jobs,
  jobId,
  onPick,
}: {
  // null when the project has only one kind of class.
  mode: EditorMode | null;
  onMode: (mode: EditorMode) => void;
  jobs: Job[];
  jobId: number | null;
  onPick: (id: number) => void;
}) {
  const showStructures = mode !== "scores" && jobs.length > 0;
  if (!mode && !showStructures) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex flex-wrap items-start justify-center gap-2 px-16">
      {mode && (
        <div role="tablist" aria-label="View" className={pill} title="Switch view (V)">
          {(["masks", "scores"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              data-testid={`mode-${m}`}
              aria-selected={mode === m}
              className={cn(
                "rounded-full px-3 py-1 font-medium text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10",
                mode === m &&
                  "bg-neutral-900 text-white hover:bg-neutral-900 dark:bg-white dark:text-neutral-900 dark:hover:bg-white",
              )}
              onClick={() => onMode(m)}
            >
              {m === "masks" ? "Masks" : "Scores"}
            </button>
          ))}
        </div>
      )}
      {showStructures && (
        <div data-testid="structure-bar" className={cn(pill, "max-w-full flex-wrap")}>
          {jobs.map((job, i) => {
            const key = structureKeyLabel(i);
            const active = job.id === jobId;
            return (
              <button
                key={job.id}
                type="button"
                data-testid={`structure-${job.name}`}
                aria-pressed={active}
                title={key ? `${job.name} (${key})` : job.name}
                className={cn(
                  "flex items-center gap-1.5 rounded-full py-1 pr-3 pl-1.5 hover:bg-black/5 dark:hover:bg-white/10",
                  active && "bg-black/10 font-medium dark:bg-white/15",
                )}
                style={active ? { boxShadow: `inset 0 0 0 2px ${job.color}` } : undefined}
                onClick={() => onPick(job.id)}
              >
                <span
                  className="flex size-5 items-center justify-center rounded-full text-[11px] font-semibold text-white tabular-nums"
                  style={{ background: job.color }}
                >
                  {key ?? ""}
                </span>
                {job.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
