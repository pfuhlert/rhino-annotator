"use client";

import { cn } from "cn";
import type { Visit } from "@/lib/api";

export default function HistoryList({
  visits,
  failed,
  patchId,
  liveCount,
  onOpen,
}: {
  visits: Visit[] | null;
  failed: boolean;
  patchId: number;
  liveCount: number;
  onOpen: (visitId: number) => void;
}) {
  if (failed || !visits)
    return (
      <p className="px-2 text-xs text-muted-foreground">
        {failed ? "Could not load history." : "Loading history"}
      </p>
    );

  return (
    <div data-testid="history-list" className="flex flex-col gap-0.5">
      {visits.map((visit, i) => {
        const current = visit.patch_id === patchId;
        const count = current ? liveCount : visit.n_annotations;
        return (
          <button
            key={visit.id}
            type="button"
            data-testid={`visit-${visit.id}`}
            aria-current={current || undefined}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-sidebar-accent",
              current && "bg-sidebar-accent font-medium",
            )}
            onClick={() => !current && onOpen(visit.id)}
          >
            <span className="w-10 shrink-0 text-muted-foreground tabular-nums">
              #{visits.length - i}
            </span>
            <span className={cn("min-w-0 flex-1 truncate", !count && "text-muted-foreground")}>
              {count ? `${count} annotation${count === 1 ? "" : "s"}` : "empty"}
            </span>
            {current && <span className="shrink-0 text-xs text-muted-foreground">current</span>}
          </button>
        );
      })}
    </div>
  );
}
