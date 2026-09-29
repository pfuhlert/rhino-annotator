"use client";

import { useEffect, useState } from "react";
import { cn } from "cn";
import AnnotationList from "@/components/AnnotationList";
import FolderPicker from "@/components/FolderPicker";
import HistoryList from "@/components/HistoryList";
import { OverlayPin, OverlayTrigger } from "@/components/Overlay";
import { Button } from "@/components/ui/button";
import {
  api,
  type Element,
  type FolderLevel,
  type Job,
  type Me,
  type Patch,
  type Visit,
} from "@/lib/api";

const TABS = [
  ["datasets", "Datasets"],
  ["annotations", "Annotations"],
  ["history", "History"],
] as const;
type Tab = (typeof TABS)[number][0];

function useFolderPath(folderId: string | null) {
  const [path, setPath] = useState<{ folder: FolderLevel; parent: FolderLevel } | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  useEffect(() => {
    if (!folderId) return;
    let live = true;
    (async () => {
      const folder = await api.folders(folderId);
      const parent = await api.folders(folder.parent_id);
      if (live) setPath({ folder, parent });
    })().catch(() => {
      if (live) setFailedId(folderId);
    });
    return () => {
      live = false;
    };
  }, [folderId]);
  return { path, failed: failedId === folderId };
}

export default function Sidebar({
  me,
  jobs,
  folderId,
  patch,
  loadFailed,
  marks,
  selectedId,
  onUseFolder,
  onOpenVisit,
  onHoverMark,
  onSelectMark,
  onDeleteMark,
  onLogout,
}: {
  me: Me;
  jobs: Job[];
  folderId: string | null;
  patch: Patch | null;
  loadFailed: boolean;
  marks: Element[];
  selectedId: string | null;
  onUseFolder: (id: string) => void;
  onOpenVisit: (visitId: number) => void;
  onHoverMark: (id: string | null) => void;
  onSelectMark: (mark: Element) => void;
  onDeleteMark: (id: string) => void;
  onLogout: () => void;
}) {
  // Until a tab is picked, follow the patch: Annotations once one loads, Datasets otherwise.
  const [pickedTab, setTab] = useState<Tab | null>(null);
  const tab = pickedTab ?? (!folderId || loadFailed ? "datasets" : "annotations");
  const [visits, setVisits] = useState<Visit[] | null>(null);
  const [visitsFailed, setVisitsFailed] = useState(false);
  // The last loaded path, possibly for the previous folder while the new one loads.
  const { path: lastPath, failed: pathFailed } = useFolderPath(folderId);
  const path = lastPath?.folder.id === folderId ? lastPath : null;
  const polygons = marks.filter((m) => m.type === "polygon").length;
  const index = visits?.findIndex((v) => v.patch_id === patch?.id) ?? -1;
  const position = visits && index >= 0 ? visits.length - index : null;

  useEffect(() => {
    let live = true;
    api
      .visits()
      .then((next) => {
        if (!live) return;
        setVisits(next);
        setVisitsFailed(false);
      })
      .catch(() => live && setVisitsFailed(true));
    return () => {
      live = false;
    };
  }, [patch?.id]);

  return (
    <>
      <div className="flex items-center justify-between p-2 pb-0">
        <span className="size-(--overlay-trigger-size) shrink-0" aria-hidden />
        <OverlayTrigger />
        <OverlayPin />
      </div>
      <button
        type="button"
        data-testid="sidebar-context"
        className="mx-2 mt-1 flex flex-col rounded-md px-2 py-1.5 text-left hover:bg-sidebar-accent"
        onClick={() => setTab("datasets")}
      >
        <span className="truncate text-sm font-medium">
          {path ? (
            <>
              {path.parent.id && (
                <span className="text-sidebar-foreground/60">{path.parent.name} / </span>
              )}
              {path.folder.name}
            </>
          ) : (
            "No dataset selected"
          )}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {position ? `Patch ${position} · ` : ""}
          {polygons} annotation{polygons === 1 ? "" : "s"}
        </span>
      </button>
      <div
        role="tablist"
        className="mx-2 mt-2 grid grid-cols-3 gap-0.5 rounded-lg bg-sidebar-accent p-0.5"
      >
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            data-testid={`tab-${id}`}
            aria-selected={tab === id}
            className={cn(
              "rounded-md px-1 py-1 text-xs font-medium text-sidebar-foreground/70 hover:text-sidebar-foreground",
              tab === id && "bg-sidebar text-sidebar-foreground shadow-sm",
            )}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        className="flex min-h-0 flex-1 flex-col overflow-auto p-2 [scrollbar-width:none]"
      >
        {tab === "datasets" &&
          (folderId && !lastPath && !pathFailed ? (
            <p className="px-2 text-xs text-muted-foreground">Loading folders</p>
          ) : (
            <FolderPicker
              selectedId={folderId}
              initialLevel={lastPath?.parent ?? null}
              onUse={onUseFolder}
            />
          ))}
        {tab !== "datasets" && !patch && (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            {loadFailed ? "No image loaded." : "Loading…"}
          </p>
        )}
        {tab === "annotations" && patch && (
          <AnnotationList
            marks={marks}
            jobs={jobs}
            selectedId={selectedId}
            nmPerPx={patch.nm_per_px}
            onHover={onHoverMark}
            onSelect={onSelectMark}
            onDelete={onDeleteMark}
          />
        )}
        {tab === "history" && patch && (
          <HistoryList
            visits={visits}
            failed={visitsFailed}
            patchId={patch.id}
            liveCount={polygons}
            onOpen={onOpenVisit}
          />
        )}
      </div>
      <div className="flex w-full items-center justify-between p-2">
        <div className="flex min-w-0 items-baseline gap-2 px-2">
          <div className="truncate text-sm font-medium">{me.username}</div>
          <div className="shrink-0 text-xs text-muted-foreground">{me.done_count} done</div>
        </div>
        <Button data-testid="logout" variant="ghost" size="sm" onClick={onLogout}>
          Log out
        </Button>
      </div>
    </>
  );
}
