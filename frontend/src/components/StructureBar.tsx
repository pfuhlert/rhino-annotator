"use client";

import { cn } from "cn";
import { CheckCheckIcon, PencilIcon, PlusIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ProjectJob } from "@/lib/api";
import { textOn } from "@/lib/projects";
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
  onReset,
  onAdd,
  onEdit,
}: {
  // null when the project has only one kind of class.
  mode: EditorMode | null;
  onMode: (mode: EditorMode) => void;
  jobs: ProjectJob[];
  jobId: number | null;
  onPick: (id: number) => void;
  // Whether the open image's masks are finished.
  complete: boolean;
  onComplete: (complete: boolean) => void;
  onReset: () => void;
  // Adds a mask class by name; absent when this user cannot change the project.
  onAdd?: (name: string) => void;
  // Renames or recolors a class in this project; absent likewise.
  onEdit?: (id: number, change: { name: string; color: string }) => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  function add() {
    const name = naming?.trim();
    setNaming(null);
    if (name) onAdd?.(name);
  }
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
            if (onEdit && editing === job.id)
              return (
                <StructureEditor
                  key={job.id}
                  job={job}
                  onDone={(change) => {
                    setEditing(null);
                    if (change) onEdit(job.id, change);
                  }}
                />
              );
            return (
              <div
                key={job.id}
                className={cn(
                  "group flex items-center rounded-xl hover:bg-black/5 dark:hover:bg-white/10",
                  active && "bg-black/10 font-medium dark:bg-white/15",
                )}
                style={active ? { boxShadow: `inset 0 0 0 2px ${job.color}` } : undefined}
              >
                <button
                  type="button"
                  data-testid={`structure-${job.name}`}
                  aria-pressed={active}
                  title={key ? `${job.name} (${key})` : job.name}
                  className="flex grow items-center gap-2 py-1 pr-2 pl-1.5 text-left"
                  onClick={() => onPick(job.id)}
                >
                  <span
                    className="flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums"
                    style={{ background: job.color, color: textOn(job.color) }}
                  >
                    {key ?? ""}
                  </span>
                  {job.name}
                </button>
                {onEdit && job.in_project && (
                  <button
                    type="button"
                    data-testid={`edit-structure-${job.name}`}
                    aria-label={`Edit ${job.name}`}
                    title="Change name or color"
                    className="mr-1.5 rounded-full p-1 text-neutral-400 opacity-0 group-hover:opacity-100 hover:text-neutral-800 focus-visible:opacity-100 dark:hover:text-neutral-100"
                    onClick={() => setEditing(job.id)}
                  >
                    <PencilIcon className="size-3" />
                  </button>
                )}
              </div>
            );
          })}
          {onAdd &&
            (naming === null ? (
              <button
                type="button"
                data-testid="add-structure"
                title="Add a mask class to this project"
                className="flex items-center gap-2 rounded-xl py-1 pr-3 pl-1.5 text-left text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10"
                onClick={() => setNaming("")}
              >
                <PlusIcon className="size-5 p-0.5 text-neutral-400" />
                New structure
              </button>
            ) : (
              <input
                data-testid="new-structure"
                autoFocus
                maxLength={64}
                placeholder="Structure name"
                className="mx-1 my-0.5 w-36 rounded-lg border border-black/15 bg-white px-2 py-1 text-sm outline-none focus:border-black/40 dark:border-white/15 dark:bg-neutral-800"
                value={naming}
                onChange={(e) => setNaming(e.target.value)}
                onBlur={add}
                onKeyDown={(e) => {
                  if (e.key === "Enter") add();
                  if (e.key === "Escape") setNaming(null);
                }}
              />
            ))}
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
          <button
            type="button"
            data-testid="image-reset"
            title="Delete this image's masks, scores and complete mark"
            className="flex items-center gap-2 rounded-xl py-1 pr-3 pl-1.5 text-left text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10"
            onClick={onReset}
          >
            <RotateCcwIcon className="size-5 p-0.5 text-neutral-400" />
            Reset image
          </button>
        </div>
      )}
    </>
  );
}

function StructureEditor({
  job,
  onDone,
}: {
  job: ProjectJob;
  // null leaves the class as it was.
  onDone: (change: { name: string; color: string } | null) => void;
}) {
  const [name, setName] = useState(job.name);
  const [color, setColor] = useState(job.color);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The canvas keeps the focus where it was, so a press there would not end the edit.
    const leave = (e: PointerEvent) => {
      const active = document.activeElement;
      const target = e.target as Element;
      if (root.current?.contains(target) || !root.current?.contains(active)) return;
      // Nor should that press draw.
      if (target.closest("[data-testid=patch-canvas]")) e.stopPropagation();
      (active as HTMLElement).blur();
    };
    window.addEventListener("pointerdown", leave, true);
    return () => window.removeEventListener("pointerdown", leave, true);
  }, []);
  function save() {
    const next = name.trim();
    const changed = next && (next !== job.name || color !== job.color);
    onDone(changed ? { name: next, color } : null);
  }
  return (
    <div
      ref={root}
      data-testid="structure-editor"
      className="flex items-center gap-2 py-0.5 pr-1 pl-1.5"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) save();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") save();
        if (e.key === "Escape") onDone(null);
      }}
    >
      <label
        className="relative size-5 shrink-0 cursor-pointer rounded-full"
        style={{ background: color }}
        title="Change color"
      >
        <input
          type="color"
          data-testid="structure-color"
          aria-label={`${job.name} color`}
          className="absolute inset-0 cursor-pointer opacity-0"
          value={color}
          onChange={(e) => setColor(e.target.value)}
        />
      </label>
      <input
        data-testid="structure-name"
        aria-label={`${job.name} name`}
        autoFocus
        maxLength={64}
        className="w-40 rounded-lg border border-black/15 bg-white px-2 py-1 text-sm outline-none focus:border-black/40 dark:border-white/15 dark:bg-neutral-800"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
    </div>
  );
}
