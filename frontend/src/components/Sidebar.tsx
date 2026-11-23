"use client";

import { ChevronsUpDownIcon, DownloadIcon, UsersIcon } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { cn } from "cn";
import AnnotationList from "@/components/AnnotationList";
import FolderPicker from "@/components/FolderPicker";
import ImageList, { MagFilter, StainFilter } from "@/components/ImageList";
import MarkedScroll from "@/components/MarkedScroll";
import { OverlayPin, OverlayTrigger } from "@/components/Overlay";
import UserMenu from "@/components/UserMenu";
import {
  api,
  type Element,
  type FolderLevel,
  type ImageCatalog,
  type Me,
  type Patch,
  type Project,
  type ProjectJob,
  type Times,
  withProject,
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
  return withProject(`/annotations/export.csv${tz ? `?tz=${encodeURIComponent(tz)}` : ""}`);
}

function useFolderPath(folderId: string | null) {
  const [path, setPath] = useState<{ folder: FolderLevel; parent: FolderLevel } | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);
  useEffect(() => {
    if (!folderId) return;
    let live = true;
    (async () => {
      const folder = await api.folders(folderId, true);
      const parent = await api.folders(folder.parent_id, true);
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

// Refetched per image (not per region) so images left behind show their final progress, after
// each save so annotation marks follow edits, and after the histology layout default changes.
// Polled while the server indexes the folder.
function useCatalog(
  folderId: string | null,
  itemId: string | null,
  saves: number,
  splitHisto: boolean,
) {
  const [catalog, setCatalog] = useState<{ folderId: string; data: ImageCatalog } | null>(null);
  const [error, setError] = useState<{ folderId: string; message: string } | null>(null);
  const [refreshes, setRefreshes] = useState(0);
  useEffect(() => {
    if (!folderId) return;
    let live = true;
    let timer = 0;
    const load = () =>
      api.images().then(
        (data) => {
          if (!live) return;
          setCatalog({ folderId, data });
          setError(null);
          if (data.indexing) timer = window.setTimeout(load, 3000);
        },
        (e: Error) =>
          live && setError({ folderId, message: e.message || "Could not load images." }),
      );
    void load();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [folderId, itemId, saves, splitHisto, refreshes]);
  const refresh = (then: () => void) =>
    void api.refreshImages().then(
      () => {
        setRefreshes((n) => n + 1);
        then();
      },
      () => {},
    );
  return {
    catalog: catalog?.folderId === folderId ? catalog.data : null,
    error: error?.folderId === folderId ? error.message : null,
    refresh,
  };
}

export default function Sidebar({
  me,
  project,
  jobs,
  hideOther,
  onHideOther,
  folderId,
  patch,
  loadFailed,
  marks,
  selectedId,
  times,
  onUseFolder,
  onOpenImage,
  onSplitImage,
  onSplitHisto,
  onRefreshed,
  onStains,
  onMags,
  onHoverMark,
  onSelectMark,
  onDeleteMark,
  onRelabelMark,
  onOpenProjects,
  onCopied,
  saves,
  onShortcuts,
  onLogout,
}: {
  me: Me;
  project: Project;
  jobs: ProjectJob[];
  hideOther: boolean;
  onHideOther: (hide: boolean) => void;
  folderId: string | null;
  patch: Patch | null;
  loadFailed: boolean;
  marks: Element[];
  selectedId: string | null;
  times: Times;
  onUseFolder: (id: string) => void;
  onOpenImage: (itemId: string) => void;
  onSplitImage: (itemId: string, split: boolean) => void;
  onSplitHisto: (split: boolean) => void;
  onRefreshed: () => void;
  onStains: (stains: (string | null)[]) => void;
  onMags: (mags: (number | null)[]) => void;
  onHoverMark: (id: string | null) => void;
  onSelectMark: (mark: Element) => void;
  onDeleteMark: (id: string) => void;
  onRelabelMark: (id: string, jobId: number) => void;
  onOpenProjects: () => void;
  onCopied: (project: Project) => void;
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
  const [exportError, setExportError] = useState<string | null>(null);
  // Fetched rather than followed, so a refusal (e.g. still indexing) is shown instead of downloaded.
  async function exportCsv() {
    setExportError(null);
    const res = await fetch(exportUrl, { credentials: "include" });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setExportError(body?.detail ?? "Could not export the annotations.");
      return;
    }
    const name = res.headers.get("Content-Disposition")?.split("''")[1];
    const link = document.createElement("a");
    link.href = URL.createObjectURL(await res.blob());
    link.download = name ? decodeURIComponent(name) : "annotations.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  }
  // The last loaded path, possibly for the previous folder while the new one loads.
  const { path: lastPath, failed: pathFailed } = useFolderPath(folderId);
  const {
    catalog,
    error: catalogError,
    refresh,
  } = useCatalog(
    me.last_folder_id === folderId ? folderId : null,
    patch?.item_id ?? null,
    saves,
    me.split_histo,
  );
  // A failed listing keeps the last catalog, which may still say it was indexing.
  const indexing = !catalogError && !!catalog?.indexing;
  const groups = useMemo(
    // Empty only while a folder is indexed for the first time.
    () =>
      catalog?.items.length
        ? groupImages(catalog.items, me.stain_filter, patch, me.mag_filter ?? [])
        : null,
    [catalog, me.stain_filter, me.mag_filter, patch],
  );
  const progress = groups && {
    done: groups.reduce((n, g) => n + g.done, 0),
    total: groups.reduce((n, g) => n + g.rows.length, 0),
  };

  return (
    <>
      <div className="flex items-center gap-2 p-2 pb-0">
        {/* Room for the fixed sidebar toggle, which sits at the row's left edge. */}
        <span
          className="w-[calc(var(--overlay-trigger-left)+var(--overlay-trigger-size)-0.5rem)] shrink-0"
          aria-hidden
        />
        <OverlayTrigger />
        <button
          type="button"
          data-testid="project-header"
          title="Switch project"
          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 text-left text-sm leading-none font-medium outline-hidden hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          onClick={onOpenProjects}
        >
          <span className="min-w-0 truncate">{project.name}</span>
          {project.visibility !== "private" && (
            <UsersIcon aria-label="Shared" className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <ChevronsUpDownIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
        </button>
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
              indexing={indexing}
              onRefresh={() => refresh(onRefreshed)}
              progress={progress}
              mark={groups && strongest(groups.map((g) => g.mark))}
              pinned={
                <>
                  <StainFilter catalog={catalog} stains={me.stain_filter} onStains={onStains} />
                  <MagFilter catalog={catalog} mags={me.mag_filter ?? []} onMags={onMags} />
                </>
              }
              selected={
                <ImageList
                  groups={groups}
                  error={catalogError ?? catalog?.listing_error ?? null}
                  indexing={indexing}
                  currentId={patch?.item_id ?? null}
                  onOpen={onOpenImage}
                  onSplit={onSplitImage}
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
            hideOther={hideOther}
            onHideOther={onHideOther}
            selectedId={selectedId}
            times={times}
            nmPerPx={patch.nm_per_px}
            onHover={onHoverMark}
            onSelect={onSelectMark}
            onDelete={onDeleteMark}
            onRelabel={onRelabelMark}
          />
        )}
      </MarkedScroll>
      {exportError && (
        <p role="alert" className="px-4 text-xs text-destructive">
          {exportError}
        </p>
      )}
      <div className="flex items-center">
        <UserMenu
          username={me.username}
          project={project}
          onCopied={onCopied}
          splitHisto={me.split_histo}
          onSplitHisto={onSplitHisto}
          onShortcuts={onShortcuts}
          onLogout={onLogout}
        />
        <a
          href={exportUrl}
          download
          onClick={(e) => {
            e.preventDefault();
            void exportCsv();
          }}
          data-testid="export-annotations"
          aria-label="Export this project's annotations as CSV"
          title="Export this project's annotations as CSV"
          className="mr-2 flex size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-hidden hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <DownloadIcon className="size-4" />
        </a>
      </div>
    </>
  );
}
