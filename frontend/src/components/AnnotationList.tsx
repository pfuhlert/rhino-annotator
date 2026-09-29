"use client";

import { useEffect, useMemo, useRef } from "react";
import { Trash2Icon } from "lucide-react";
import { cn } from "cn";
import { aiTaskId, type Element, type Job } from "@/lib/api";
import { polygonArea } from "@/lib/geometry";

function formatArea(px2: number, nmPerPx: number | null) {
  if (!nmPerPx) return `${Math.round(px2).toLocaleString()} px²`;
  const um2 = (px2 * nmPerPx * nmPerPx) / 1e6;
  return `${um2 < 10 ? um2.toFixed(2) : Math.round(um2).toLocaleString()} µm²`;
}

export default function AnnotationList({
  marks,
  jobs,
  selectedId,
  nmPerPx,
  onHover,
  onSelect,
  onDelete,
}: {
  marks: Element[];
  jobs: Job[];
  selectedId: string | null;
  nmPerPx: number | null;
  onHover: (id: string | null) => void;
  onSelect: (mark: Element) => void;
  onDelete: (id: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selectedId) return;
    listRef.current
      ?.querySelector(`[data-mark-id="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  // Normalizing each polygon runs a clipping pass, so only redo it when the marks change.
  const areas = useMemo(
    () => new Map(marks.filter((m) => m.type === "polygon").map((m) => [m.id, polygonArea(m)])),
    [marks],
  );
  const groups = jobs
    .map((job) => ({
      job,
      marks: marks.filter((m) => m.type === "polygon" && m.jobId === job.id),
    }))
    .filter((g) => g.marks.length);

  if (!groups.length)
    return (
      <p className="px-2 py-1 text-xs text-muted-foreground">No annotations on this image yet.</p>
    );

  return (
    <div
      ref={listRef}
      data-testid="annotation-list"
      className="flex flex-col gap-3"
      onPointerLeave={() => onHover(null)}
    >
      {groups.map(({ job, marks: rows }) => (
        <section key={job.id} className="flex flex-col gap-0.5">
          <h3 className="flex h-7 items-center gap-2 px-2 text-xs font-medium text-sidebar-foreground/70">
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: job.color }} />
            <span className="truncate">{job.name}</span>
            <span className="tabular-nums">{rows.length}</span>
          </h3>
          {rows.map((mark, i) => (
            <div
              key={mark.id}
              data-mark-id={mark.id}
              className={cn(
                "group flex items-center rounded-md hover:bg-sidebar-accent",
                mark.id === selectedId && "bg-sidebar-accent",
              )}
              onPointerEnter={() => onHover(mark.id)}
            >
              <button
                type="button"
                data-testid={`annotation-${mark.id}`}
                aria-pressed={mark.id === selectedId}
                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
                onClick={() => onSelect(mark)}
              >
                <span className="w-5 shrink-0 text-xs text-muted-foreground tabular-nums">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate tabular-nums">
                  {formatArea(areas.get(mark.id) ?? 0, nmPerPx)}
                </span>
                {aiTaskId(mark.id) && (
                  <span className="shrink-0 rounded bg-muted px-1 text-[10px] font-medium text-muted-foreground">
                    AI
                  </span>
                )}
              </button>
              <button
                type="button"
                data-testid={`delete-annotation-${mark.id}`}
                aria-label="Delete annotation"
                className="mr-1 rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive"
                onClick={() => onDelete(mark.id)}
              >
                <Trash2Icon className="size-3.5" />
              </button>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
