"use client";

import { cn } from "cn";
import { CheckCheckIcon } from "lucide-react";
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
  complete,
  onComplete,
}: {
  // null when the project has only one kind of class.
  mode: EditorMode | null;
  onMode: (mode: EditorMode) => void;
  jobs: Job[];
  jobId: number | null;
  onPick: (id: number) => void;
  // Whether the open image's masks are finished.
  complete: boolean;
  onComplete: (complete: boolean) => void;
}) {
  const showStructures = mode !== "scores" && jobs.length > 0;
  if (!mode && !showStructures) return null;
  return (
    <>
      {mode && (
        <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-16">
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
        </div>
      )}
      {showStructures && (
        // A column beside the image: square images leave room at the sides of the window.
        <div
          data-testid="structure-bar"
          className={cn(
            pill,
            "absolute top-1/2 right-3 z-10 max-h-[calc(100%-10rem)] -translate-y-1/2 flex-col items-stretch overflow-y-auto rounded-2xl [scrollbar-width:none]",
          )}
        >
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
                  "flex items-center gap-2 rounded-xl py-1 pr-3 pl-1.5 text-left hover:bg-black/5 dark:hover:bg-white/10",
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
          <button
            type="button"
            data-testid="image-complete"
            aria-pressed={complete}
            title="Every structure on this image is masked; the rest is background (C)"
            className={cn(
              "mt-1 flex items-center gap-2 rounded-xl border-t border-black/10 py-1 pr-3 pl-1.5 text-left hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/10",
              complete && "bg-emerald-600/15 font-medium text-emerald-800 dark:text-emerald-300",
            )}
            onClick={() => onComplete(!complete)}
          >
            <CheckCheckIcon
              className={cn("size-5 p-0.5", complete ? "text-emerald-600" : "text-neutral-400")}
            />
            {complete ? "Complete" : "Mark complete"}
          </button>
        </div>
      )}
    </>
  );
}
