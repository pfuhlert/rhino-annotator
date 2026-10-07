"use client";

import { DownloadIcon } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { cn } from "cn";
import AnnotationList from "@/components/AnnotationList";
import FolderPicker from "@/components/FolderPicker";
import ImageList, { StainFilter } from "@/components/ImageList";
import MarkedScroll from "@/components/MarkedScroll";
import { OverlayPin, OverlayTrigger } from "@/components/Overlay";
import UserMenu from "@/components/UserMenu";
import {
  api,
  type Element,
  type FolderLevel,
  type ImageCatalog,
  type Job,
  type Me,
  type Patch,
} from "@/lib/api";
import { groupImages, strongest } from "@/lib/images";

const TABS = [
  ["images", "Images"],
  ["annotations", "Annotations"],
] as const;
type Tab = (typeof TABS)[number][0];
const TAB_KEY = "sidebar-tab";

function readTab(): Tab | null {
  try {
    const tab = localStorage.getItem(TAB_KEY);
    return TABS.some(([id]) => id === tab) ? (tab as Tab) : null;
  } catch {
    return null;
  }
}

// The server render can't know the viewer's timezone, which names the downloaded file.
function useExportUrl() {
  const tz = useSyncExternalStore(
    () => () => {},
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    () => null,
  );
  return `/annotations/export.csv${tz ? `?tz=${encodeURIComponent(tz)}` : ""}`;
}

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

// Refetched per image (not per region) so images left behind show their final progress, and after
// each save so annotation marks follow edits.
function useCatalog(folderId: string | null, itemId: string | null, saves: number) {
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
  }, [folderId, itemId, saves]);
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
  saves,
  onShortcuts,
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
  // Bumped after each save.
  saves: number;
  onShortcuts: () => void;
  onLogout: () => void;
}) {
  // Images while no image can load; otherwise the last picked tab, Annotations by default.
  const [pickedTab, setPickedTab] = useState(readTab);
  const tab = !folderId || loadFailed ? "images" : (pickedTab ?? "annotations");
  const setTab = (next: Tab) => {
    setPickedTab(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {}
  };
  const exportUrl = useExportUrl();
  // The last loaded path, possibly for the previous folder while the new one loads.
  const { path: lastPath, failed: pathFailed } = useFolderPath(folderId);
  const { catalog, failed: catalogFailed } = useCatalog(
    me.last_folder_id === folderId ? folderId : null,
    patch?.item_id ?? null,
    saves,
  );
  const groups = useMemo(
    () => (catalog ? groupImages(catalog.items, me.stain_filter, patch) : null),
    [catalog, me.stain_filter, patch],
  );
  const progress = groups && {
    done: groups.reduce((n, g) => n + g.done, 0),
    total: groups.reduce((n, g) => n + g.rows.length, 0),
  };

  return (
    <>
      <div className="flex items-center justify-between p-2 pb-0">
        <span className="size-(--overlay-trigger-size) shrink-0" aria-hidden />
        <OverlayTrigger />
        <OverlayPin />
      </div>
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
      <MarkedScroll
        role="tabpanel"
        // No top padding: pinned rows would leave a see-through band above them.
        className="flex min-h-0 flex-1 flex-col overflow-auto px-2 pb-2"
      >
        {tab === "images" &&
          (folderId && !lastPath && !pathFailed ? (
            <p className="px-2 text-xs text-muted-foreground">Loading folders</p>
          ) : (
            <FolderPicker
              selectedId={folderId}
              initialLevel={lastPath?.parent ?? null}
              onUse={onUseFolder}
              progress={progress}
              mark={groups && strongest(groups.map((g) => g.mark))}
              pinned={
                <StainFilter catalog={catalog} stains={me.stain_filter} onStains={onStains} />
              }
              selected={
                <ImageList
                  groups={groups}
                  failed={catalogFailed}
                  currentId={patch?.item_id ?? null}
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
      </MarkedScroll>
      <div className="flex items-center">
        <UserMenu username={me.username} onShortcuts={onShortcuts} onLogout={onLogout} />
        <a
          href={exportUrl}
          download
          data-testid="export-annotations"
          aria-label="Export all annotations as CSV"
          title="Export all annotations as CSV"
          className="mr-2 flex size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-hidden hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <DownloadIcon className="size-4" />
        </a>
      </div>
    </>
  );
}
