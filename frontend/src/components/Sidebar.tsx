"use client";

import { useEffect, useState } from "react";
import { cn } from "cn";
import AnnotationList from "@/components/AnnotationList";
import FolderPicker from "@/components/FolderPicker";
import ImageList, { StainFilter } from "@/components/ImageList";
import { OverlayPin, OverlayTrigger } from "@/components/Overlay";
import { Button } from "@/components/ui/button";
import {
  api,
  type Element,
  type FolderLevel,
  type ImageCatalog,
  type Job,
  type Me,
  type Patch,
} from "@/lib/api";

const TABS = [
  ["images", "Images"],
  ["annotations", "Annotations"],
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

// Refetched per image (not per region) so images left behind show their final progress.
function useCatalog(folderId: string | null, itemId: string | null) {
  const [catalog, setCatalog] = useState<{ folderId: string; data: ImageCatalog } | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  useEffect(() => {
    if (!folderId) return;
    let live = true;
    api.images().then(
      (data) => live && setCatalog({ folderId, data }),
      () => live && setFailedId(folderId),
    );
    return () => {
      live = false;
    };
  }, [folderId, itemId]);
  return {
    catalog: catalog?.folderId === folderId ? catalog.data : null,
    failed: failedId === folderId,
  };
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
  onOpenImage,
  onStains,
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
  onOpenImage: (itemId: string) => void;
  onStains: (stains: (string | null)[]) => void;
  onHoverMark: (id: string | null) => void;
  onSelectMark: (mark: Element) => void;
  onDeleteMark: (id: string) => void;
  onLogout: () => void;
}) {
  // Until a tab is picked, follow the patch: Annotations once one loads, Images otherwise.
  const [pickedTab, setTab] = useState<Tab | null>(null);
  const tab = pickedTab ?? (!folderId || loadFailed ? "images" : "annotations");
  // The last loaded path, possibly for the previous folder while the new one loads.
  const { path: lastPath, failed: pathFailed } = useFolderPath(folderId);
  const path = lastPath?.folder.id === folderId ? lastPath : null;
  const { catalog, failed: catalogFailed } = useCatalog(
    me.last_folder_id === folderId ? folderId : null,
    patch?.item_id ?? null,
  );
  const polygons = marks.filter((m) => m.type === "polygon").length;
  const slide = patch?.slide;
  const folderLabel = path ? (
    <>
      {path.parent.id && <span className="text-sidebar-foreground/60">{path.parent.name} / </span>}
      {path.folder.name}
    </>
  ) : (
    "No dataset selected"
  );

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
        onClick={() => setTab("images")}
      >
        <span className="truncate text-sm font-medium">{folderLabel}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {slide ? `Region ${slide.current + 1}/${slide.tiles.length} · ` : ""}
          {polygons} annotation{polygons === 1 ? "" : "s"}
        </span>
      </button>
      <div
        role="tablist"
        className="mx-2 my-2 grid grid-cols-2 gap-0.5 rounded-lg bg-sidebar-accent p-0.5"
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
        // No top padding: pinned rows would leave a see-through band above them.
        className="flex min-h-0 flex-1 flex-col overflow-auto px-2 pb-2 [scrollbar-width:none]"
      >
        {tab === "images" &&
          (folderId && !lastPath && !pathFailed ? (
            <p className="px-2 text-xs text-muted-foreground">Loading folders</p>
          ) : (
            <FolderPicker
              selectedId={folderId}
              initialLevel={lastPath?.parent ?? null}
              onUse={onUseFolder}
              pinned={
                <StainFilter catalog={catalog} stains={me.stain_filter} onStains={onStains} />
              }
              selected={
                <ImageList
                  catalog={catalog}
                  failed={catalogFailed}
                  patch={patch}
                  stains={me.stain_filter}
                  onOpen={onOpenImage}
                />
              }
            />
          ))}
        {tab === "annotations" && !patch && (
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
