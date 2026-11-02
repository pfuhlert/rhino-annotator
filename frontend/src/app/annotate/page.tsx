"use client";

import { useRouter } from "next/navigation";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AiCursorStatus } from "@/components/AiCursorStatus";
import { BrushSizeControl } from "@/components/BrushSizeControl";
import PatchCanvas, { type AnnotatorApi } from "@/components/PatchCanvas";
import ProjectsPanel, { expanded } from "@/components/ProjectsPanel";
import Sidebar from "@/components/Sidebar";
import ShortcutsDialog from "@/components/ShortcutsDialog";
import SlideMap from "@/components/SlideMap";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Overlay } from "@/components/Overlay";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  api,
  type Element,
  type Me,
  type Patch,
  type Project,
  type ProjectJob,
  type Times,
  type ViewRect,
  setRequestProject,
} from "@/lib/api";
import type { Tool } from "@/lib/draw";
import { pickerJobs } from "@/lib/projects";
import { createAnnotationSync } from "@/lib/annotation-sync";
import { useAi } from "@/lib/use-ai";
import { isTypingTarget } from "@/lib/keys";
import { type ShareLink, parseShareLink, shareLinkQuery } from "@/lib/share-link";
import { TOOLS, useEnabledTools } from "@/lib/tools";
import { errorMessage } from "@/lib/utils";

const FAILURE_MESSAGE_MS = 5000;

type Menu = "job" | "tool" | "size";

// The server is still listing the folder's images.
function isIndexing(error: unknown) {
  return (error as { status?: number }).status === 503;
}

// A shared link's view, relative to the patch it opened.
function linkView({ view }: ShareLink, { image }: Patch): ViewRect {
  return { ...view, left: view.left - image.left, top: view.top - image.top };
}

function LoadError({
  message,
  className,
  retry = true,
}: {
  message: string;
  className?: string;
  retry?: boolean;
}) {
  return (
    <p role="alert" data-testid="load-error" className={className}>
      {message}{" "}
      {retry && (
        <button className="underline" onClick={() => window.location.reload()}>
          Retry
        </button>
      )}
    </p>
  );
}

// Remounted per project, so nothing from one project's session leaks into the next.
function Editor({
  projectId,
  paused,
  leaveRef,
  onOpenProjects,
  onNoProject,
}: {
  projectId: number;
  // The projects overlay is open; editor shortcuts stay off.
  paused: boolean;
  // Saves pending edits before switching; false when the save failed.
  leaveRef: RefObject<() => Promise<boolean>>;
  onOpenProjects: () => void;
  onNoProject: () => void;
}) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [allJobs, setJobs] = useState<ProjectJob[]>([]);
  const [hideOther, setHideOther] = useState(false);
  const [jobId, setJobId] = useState<number | null>(null);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [patch, setPatch] = useState<Patch | null>(null);
  const [view, setView] = useState<{ patchId: number; rect: ViewRect; prepare: boolean } | null>(
    null,
  );
  // Next can return a tile already on screen; every open needs a fresh canvas to match the new sync.
  const [openCount, setOpenCount] = useState(0);
  // A shared link opens zoomed to the sender's view (patch pixels).
  const [initialView, setInitialView] = useState<ViewRect | null>(null);
  // First, so every request this editor makes names its project.
  useEffect(() => {
    setRequestProject(projectId);
    return () => setRequestProject(null);
  }, [projectId]);
  useEffect(() => {
    if (!view?.prepare) return;
    // Large tissue regions prepare AI tiles for what the user is looking at once the view settles.
    const timer = window.setTimeout(() => {
      const { left, top, width, height } = view.rect;
      const rect = {
        left: Math.floor(left),
        top: Math.floor(top),
        width: Math.max(1, Math.ceil(width)),
        height: Math.max(1, Math.ceil(height)),
      };
      void api.prepare(view.patchId, rect).catch(() => {});
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [view]);
  const [marks, setMarks] = useState<Element[]>([]);
  const [times, setTimes] = useState<Times>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectAfterSwitch = useRef<string | null>(null);
  const [chosenTool, setTool] = useState<Tool>("polygon");
  const enabledTools = useEnabledTools();
  const tool = enabledTools.includes(chosenTool) ? chosenTool : enabledTools[0];
  const [brushRadius, setBrushRadius] = useState(16);
  const [openMenu, setOpenMenu] = useState<Menu | null>(null);
  const [busy, setBusy] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [saves, setSaves] = useState(0);
  const toggleMenu = (id: Menu) => (open: boolean) =>
    setOpenMenu(open ? id : (cur) => (cur === id ? null : cur));
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  const annoRef = useRef<AnnotatorApi | null>(null);
  const patchRef = useRef<Patch | null>(null);
  const saveTimer = useRef<number>(0);
  const sync = useRef<ReturnType<typeof createAnnotationSync> | null>(null);
  const [saveError, setSaveError] = useState<{ message: string; stale: boolean } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [indexing, setIndexing] = useState(false);
  // The address bar already shows the fallback patch, so reloading cannot retry a failed link.
  const [linkFailed, setLinkFailed] = useState(false);
  const [brokenImage, setBrokenImage] = useState<number | null>(null);
  const ai = useAi(patch?.id, (elements, sourcePatchId, added) => {
    if (patchRef.current?.id !== sourcePatchId) return;
    annoRef.current?.add(elements);
    setTimes((t) => ({ ...t, ...added }));
  });
  const pending = useMemo(
    () => ai.tasks.filter((t) => t.patch_id === patch?.id && t.status !== "failed"),
    [ai.tasks, patch?.id],
  );
  // The project's classes for another image kind join the other labels on this image.
  const kind = patch?.kind;
  const jobs = useMemo(
    () => allJobs.map((j) => ({ ...j, in_project: j.in_project && (!kind || j.kind === kind) })),
    [allJobs, kind],
  );
  // Each image starts on a class of its kind, unless the project has none for it.
  useEffect(() => {
    const own = jobs.filter((j) => j.in_project);
    if (jobId != null && own.length && !own.some((j) => j.id === jobId)) void switchJob(own[0].id);
    // Only on opening an image: selecting an old annotation may pick a class of another kind.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patch]);
  // Hidden classes are not drawn; the one being edited always is.
  const canvasJobs = useMemo(
    () => (hideOther ? pickerJobs(jobs, jobId) : jobs),
    [hideOther, jobs, jobId],
  );
  const failed = ai.tasks.filter((t) => t.status === "failed");
  const failedIds = failed.map((t) => t.id).join(",");
  const cancelAi = ai.cancel;
  useEffect(() => {
    if (!failedIds) return;
    // Any change to the failed set clears this timer, so it only dismisses tasks that are still failed.
    const timer = setTimeout(() => {
      for (const id of failedIds.split(",")) void cancelAi(id);
    }, FAILURE_MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [failedIds, cancelAi]);

  useEffect(() => {
    patchRef.current = patch;
  }, [patch]);

  const showPatch = useCallback((next: Patch, initial: ViewRect | null = null) => {
    patchRef.current = next;
    setInitialView(initial);
    annoRef.current = null;
    sync.current = createAnnotationSync(next.elements, (changes) =>
      api.edit(next.id, next.shared_layer, changes).then(({ times: saved }) => {
        if (patchRef.current?.id === next.id) setTimes((t) => ({ ...t, ...saved }));
      }),
    );
    setOpenCount((n) => n + 1);
    setPatch(next);
    setMarks(next.elements);
    setTimes(next.times);
    setSelectedId(null);
    setLoadError(null);
    setIndexing(false);
    setLinkFailed(false);
    if (next.job_id) setJobId(next.job_id);
    if (next.folder_id) setFolderId(next.folder_id);
    // The server picks a folder for users without one; the image list waits for that confirmation.
    setMe((cur) => cur && { ...cur, last_folder_id: next.folder_id });
  }, []);

  // Only the most recent load may show its patch; a folder switch also invalidates older loads.
  const loadSeq = useRef(0);
  const stainSave = useRef<Promise<unknown>>(Promise.resolve());
  const loadLatest = useCallback(
    async (load: () => Promise<Patch>, initial?: (next: Patch) => ViewRect) => {
      const seq = ++loadSeq.current;
      try {
        const next = await load();
        if (seq === loadSeq.current) showPatch(next, initial?.(next));
      } catch (error) {
        if (seq === loadSeq.current) throw error;
      }
    },
    [showPatch],
  );

  // What the wait opens instead of the folder's first image, e.g. a shared link.
  const indexRetry = useRef<(() => Promise<void>) | null>(null);
  // Without an image the sidebar learns the browsed folder from its listing instead.
  const waitForIndex = useCallback(async (retry: (() => Promise<void>) | null = null) => {
    indexRetry.current = retry;
    setIndexing(true);
    const { folder_id } = await api.images();
    setFolderId(folder_id);
    setMe((cur) => cur && { ...cur, last_folder_id: folder_id });
  }, []);
  // Opens the folder's first image once the server has listed them.
  useEffect(() => {
    if (patch || !indexing) return;
    const poll = () =>
      (indexRetry.current?.() ?? loadLatest(api.currentPatch)).catch((error) => {
        if (isIndexing(error)) return;
        setIndexing(false);
        setLoadError(errorMessage(error));
      });
    const timer = window.setInterval(() => void poll(), 3000);
    return () => window.clearInterval(timer);
  }, [patch, indexing, loadLatest]);

  useEffect(() => {
    (async () => {
      try {
        const opening = await api.openProject(projectId).catch((error) => {
          if ((error as { status?: number }).status === 404) return null;
          throw error;
        });
        if (!opening) return onNoProject();
        setProject(opening);
        // Opening a link may switch the dataset, which changes the folder fetched below.
        const link = parseShareLink(window.location.search);
        const openLink = ({ image, dataset, view }: ShareLink) =>
          api.openImage(image, { folder_id: dataset, view });
        let linkError: string | null = null;
        let linkIndexing = false;
        const opened = link
          ? await openLink(link).catch((error) => {
              if ((error as { status?: number }).status === 401) throw error;
              if (isIndexing(error)) linkIndexing = true;
              else linkError = errorMessage(error);
              return null;
            })
          : null;
        const [who, jobList] = await Promise.all([api.me(), api.jobs()]);
        setMe(who);
        setJobs(jobList);
        const own = jobList.filter((j) => j.in_project);
        const job = own.find((j) => j.id === who.last_job_id)?.id ?? own[0]?.id ?? null;
        setJobId(job);
        if (job != null && job !== who.last_job_id) setMe(await api.setJob(job));
        setFolderId(who.last_folder_id);
        // The patch carries the job from before the remap above.
        if (link && opened) showPatch({ ...opened, job_id: job }, linkView(link, opened));
        // The link opens once its dataset is indexed, instead of the folder's first image.
        else if (link && linkIndexing) {
          const retry = () =>
            loadLatest(
              () => openLink(link),
              (next) => linkView(link, next),
            );
          void waitForIndex(retry).catch(() => {});
        } else await loadLatest(api.currentPatch);
        if (linkError) {
          setLoadError(`Could not open the shared image: ${linkError}`);
          setLinkFailed(true);
        }
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 401)
          router.replace(`/?next=${encodeURIComponent(location.pathname + location.search)}`);
        // No project to work in, e.g. it was deleted or unshared.
        else if (status === 409) onNoProject();
        else if (isIndexing(error)) void waitForIndex().catch(() => {});
        else setLoadError(errorMessage(error));
      }
    })();
    // Runs once per mount; the parent remounts the editor for another project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadLatest, showPatch, router, waitForIndex]);

  // The address bar always links to the open image and the visible area.
  useEffect(() => {
    if (!patch || !project) return;
    const { image } = patch;
    const rect =
      view?.patchId === patch.id
        ? view.rect
        : (initialView ?? { left: 0, top: 0, width: image.width, height: image.height });
    const query = shareLinkQuery({
      dataset: patch.folder_id,
      image: patch.item_id,
      view: { ...rect, left: rect.left + image.left, top: rect.top + image.top },
    });
    window.history.replaceState(null, "", `/annotate?project=${project.id}&${query}`);
  }, [patch, view, initialView, project]);

  async function switchJob(id: number) {
    setJobId(id);
    setMe(await api.setJob(id));
  }

  async function persist() {
    const saver = sync.current;
    if (!saver || !annoRef.current) return;
    try {
      await saver.save(annoRef.current.toElements());
      setSaveError(null);
      setSaves((n) => n + 1);
    } catch (error) {
      // The server refuses saves into a layer the editor did not load; retrying cannot help.
      const stale = (error as { status?: number }).status === 412;
      setSaveError({
        stale,
        message: stale
          ? "This project's sharing changed, so these changes were not saved. Reload the page to annotate the current layer."
          : "Changes could not be saved. Please retry before leaving.",
      });
      throw error;
    }
  }

  function cancelLatestPending() {
    const task = pending.at(-1);
    if (task) void ai.cancel(task.id);
    return !!task;
  }

  function undo() {
    if (!annoRef.current?.cancelDraft() && !cancelLatestPending()) annoRef.current?.undo();
  }

  function onCanvasChange() {
    setMarks([...(annoRef.current?.toElements() ?? [])]);
    queueSave();
  }

  function selectMark(mark: Element) {
    if (mark.jobId === jobId) return annoRef.current?.select(mark.id);
    selectAfterSwitch.current = mark.id;
    void switchJob(mark.jobId);
  }

  useEffect(() => {
    const id = selectAfterSwitch.current;
    selectAfterSwitch.current = null;
    if (id) annoRef.current?.select(id);
  }, [jobId]);

  function queueSave() {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void persist().catch(() => {}), 200);
  }

  // persist() shows its own error, so a failed save only stops the navigation.
  async function saveBeforeLeaving() {
    annoRef.current?.flush();
    window.clearTimeout(saveTimer.current);
    return persist().then(
      () => true,
      () => false,
    );
  }

  // Copied annotations join the open image like AI results. Saving first makes the server's
  // marks the canvas's plus the copies.
  async function showCopied(next: Project) {
    setProject(next);
    // The copies may bring classes from outside the project.
    setJobs(await api.jobs());
    if (!(await saveBeforeLeaving())) return;
    const current = await api.currentPatch();
    if (current.id !== patchRef.current?.id) return;
    annoRef.current?.add(current.elements);
    setTimes((t) => ({ ...t, ...current.times }));
  }

  // Without a patch there is nothing to save, e.g. after the folder's first image failed to load.
  async function go(load: () => Promise<Patch>) {
    if (jobId == null || busy) return;
    setBusy(true);
    try {
      await stainSave.current;
      if (await saveBeforeLeaving()) await loadLatest(load);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function finish(kind: "next" | "prev") {
    return go(kind === "prev" ? api.prevPatch : api.nextPatch);
  }

  // Optimistic so quick toggles build on each other; saves are chained so the server keeps the
  // last choice, and navigation waits for them so Next uses the filter on screen.
  function setStains(stains: (string | null)[]) {
    setMe((cur) => cur && { ...cur, stain_filter: stains });
    stainSave.current = stainSave.current
      .then(() => api.setStains(stains))
      .catch((error) => {
        setLoadError(`Could not change the stain filter. ${errorMessage(error)}`);
        return api.me().then(setMe, () => {});
      });
  }

  async function switchFolder(id: string) {
    if (id === folderId || busy) return;
    loadSeq.current++;
    setBusy(true);
    const previous = folderId;
    let switched = false;
    try {
      if (!(await saveBeforeLeaving())) return;
      setFolderId(id);
      setMe(await api.setFolder(id));
      switched = true;
      await loadLatest(api.currentPatch);
    } catch (error) {
      if (isIndexing(error)) void waitForIndex().catch(() => {});
      else setLoadError(`Could not switch datasets. ${errorMessage(error)}`);
      // Match the server: keep the old dataset if it was never switched, otherwise drop the old patch.
      if (!switched) setFolderId(previous);
      else {
        patchRef.current = null;
        annoRef.current = null;
        sync.current = null;
        setPatch(null);
        setMarks([]);
        setSelectedId(null);
      }
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    leaveRef.current = saveBeforeLeaving;
    keyHandler.current = (e: KeyboardEvent) => {
      if (paused) return;
      // Keys inside the dialog belong to it; isTypingTarget keeps them from the canvas too.
      if (shortcutsOpen) {
        if (e.key === "?") setShortcutsOpen(false);
        return;
      }
      if (isTypingTarget(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "?") {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (k === "tab") {
        e.preventDefault();
        const dir = e.shiftKey ? -1 : 1;
        const n = enabledTools.length;
        setTool(enabledTools[(enabledTools.indexOf(tool) + dir + n) % n]);
        return;
      }
      if (k === "escape" && !annoRef.current?.cancelDraft()) cancelLatestPending();
      const keyed = TOOLS.find(([, , key]) => key.toLowerCase() === k)?.[0];
      if (!e.ctrlKey && !e.metaKey && !e.altKey && keyed && enabledTools.includes(keyed)) {
        e.preventDefault();
        e.stopPropagation();
        setTool(keyed);
        return;
      }
      if ((k === "z" || k === "y") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (k === "y" || e.shiftKey) annoRef.current?.redo();
        else undo();
      }
      if (e.metaKey || e.ctrlKey) return;
      const direction =
        k === "n" || k === "f" ? "next" : k === "b" || k === "arrowleft" ? "prev" : null;
      if (direction) {
        e.preventDefault();
        e.stopPropagation();
        void finish(direction);
      }
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  if (!me || !project || jobId == null) {
    return (
      <main className="flex min-h-full items-center justify-center text-sm text-muted-foreground">
        {loadError ? <LoadError message={loadError} /> : "Loading"}
      </main>
    );
  }

  const sidebar = (
    <Sidebar
      me={me}
      project={project}
      jobs={jobs}
      hideOther={hideOther}
      onHideOther={setHideOther}
      folderId={folderId}
      patch={patch}
      loadFailed={!patch && (!!loadError || indexing)}
      marks={marks}
      selectedId={selectedId}
      times={times}
      onUseFolder={(id) => void switchFolder(id)}
      onOpenImage={(id) => void go(() => api.openImage(id))}
      // A failed listing stopped the wait for the folder's first image; a refresh resumes it.
      onRefreshed={() => {
        if (patch) return;
        setLoadError(null);
        setIndexing(true);
      }}
      onStains={setStains}
      onHoverMark={(id) => annoRef.current?.highlight(id)}
      onSelectMark={selectMark}
      onDeleteMark={(id) => annoRef.current?.remove(id)}
      onRelabelMark={(id, job) => annoRef.current?.relabel(id, job)}
      onOpenProjects={onOpenProjects}
      onCopied={(next) => void showCopied(next)}
      saves={saves}
      onShortcuts={() => setShortcutsOpen(true)}
      onLogout={async () => {
        await api.logout();
        router.replace("/");
      }}
    />
  );

  return (
    <Overlay sidebar={sidebar}>
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      {!patch ? (
        <main
          data-testid="annotate-app"
          className="flex min-h-0 w-full flex-1 items-center justify-center bg-canvas p-8 text-center text-sm text-muted-foreground"
        >
          {loadError ? (
            <LoadError
              message={`${loadError} Choose another dataset in the sidebar.`}
              className="max-w-md"
            />
          ) : indexing ? (
            "Indexing folder…"
          ) : (
            "Loading"
          )}
        </main>
      ) : (
        <main
          data-testid="annotate-app"
          className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-canvas"
        >
          <PatchCanvas
            key={`${patch.id}:${openCount}`}
            image={patch.image}
            initialView={initialView}
            onVisibleChange={(rect) =>
              setView({ patchId: patch.id, rect, prepare: patch.image.prepare_view })
            }
            pending={pending}
            onAiPrompt={(prompt) => ai.submit(patch.id, jobId, prompt)}
            onRemote={(elements) => sync.current?.accept(elements)}
            nmPerPixel={patch.nm_per_px}
            jobId={jobId}
            jobs={canvasJobs}
            marks={patch.elements}
            tool={tool}
            radius={brushRadius}
            onRadiusChange={setBrushRadius}
            onReady={(a) => {
              annoRef.current = a;
            }}
            onChange={onCanvasChange}
            onSelect={setSelectedId}
            onImageError={() => setBrokenImage(patch.id)}
            onImageLoad={() => setBrokenImage(null)}
          />
          <AiCursorStatus count={pending.length} worker={ai.worker} />
          {failed.length > 0 && (
            <div
              data-testid="ai-errors"
              className="absolute right-4 top-4 z-20 max-w-sm space-y-1 rounded-md border bg-background/95 px-3 py-2 text-xs shadow"
            >
              {failed.map((task) => (
                <p key={task.id} role="alert">
                  {`${task.box ? "AI Box" : "AI point"} failed: ${task.error || "Segmentation failed."}`}
                </p>
              ))}
            </div>
          )}
          {(loadError || brokenImage === patch.id) && (
            <LoadError
              message={
                loadError ?? "The image could not be loaded. The image server may be unavailable."
              }
              className="absolute top-4 left-1/2 z-20 max-w-md -translate-x-1/2 rounded bg-background p-3 text-sm"
              retry={!linkFailed}
            />
          )}
          {saveError && (
            <div
              role="alert"
              className="absolute left-4 top-4 z-20 rounded bg-background p-3 text-sm"
            >
              {saveError.message}{" "}
              {saveError.stale ? (
                <button className="underline" onClick={() => location.reload()}>
                  Reload
                </button>
              ) : (
                <button className="underline" onClick={() => void persist().catch(() => {})}>
                  Retry save
                </button>
              )}
            </div>
          )}
          <footer className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/70 to-transparent px-4 py-4">
            {patch.slide && (
              <SlideMap
                slide={patch.slide}
                image={patch.image}
                view={view?.patchId === patch.id ? view.rect : null}
              />
            )}
            <div
              data-scale-bar-anchor
              className="pointer-events-auto flex flex-wrap items-center justify-center gap-2"
            >
              <Button
                data-testid="prev"
                variant="outline"
                disabled={busy}
                onClick={() => void finish("prev")}
              >
                Previous (B)
              </Button>
              <Select
                value={String(jobId)}
                open={openMenu === "job"}
                onOpenChange={toggleMenu("job")}
                onValueChange={(id) => void switchJob(Number(id))}
              >
                <SelectTrigger
                  data-testid="job-switcher"
                  aria-label="Job"
                  className="bg-background"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="center" side="top">
                  {pickerJobs(jobs, jobId).map((j) => (
                    <SelectItem key={j.id} value={String(j.id)} data-testid={`job-${j.name}`}>
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: j.color }}
                      />
                      {j.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={tool}
                open={openMenu === "tool"}
                onOpenChange={toggleMenu("tool")}
                onValueChange={(id) => setTool(id as Tool)}
              >
                <SelectTrigger
                  data-testid="tool-switcher"
                  aria-label="Tool"
                  className="bg-background"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="center" side="top">
                  {TOOLS.filter(([id]) => enabledTools.includes(id)).map(([id, label, key]) => (
                    <SelectItem key={id} value={id} data-testid={`tool-${id}`}>
                      {label} ({key})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {tool === "brush" && (
                <BrushSizeControl
                  value={brushRadius}
                  onChange={setBrushRadius}
                  open={openMenu === "size"}
                  onOpenChange={toggleMenu("size")}
                />
              )}
              <Button data-testid="undo" variant="outline" onClick={undo}>
                Undo (Ctrl+Z)
              </Button>
              <Button data-testid="redo" variant="outline" onClick={() => annoRef.current?.redo()}>
                Redo (Ctrl+Y)
              </Button>
              <Button
                data-testid="next"
                variant="outline"
                disabled={busy}
                onClick={() => void finish("next")}
              >
                Next (N)
              </Button>
            </div>
          </footer>
        </main>
      )}
    </Overlay>
  );
}

// The editor for the current project, with the projects list as an overlay above it.
export default function AnnotatePage() {
  const router = useRouter();
  // undefined until resolved; null when there is no project to open.
  const [projectId, setProjectId] = useState<number | null | undefined>(undefined);
  // Bumped to reopen the same project after its settings change.
  const [generation, setGeneration] = useState(0);
  const [overlay, setOverlay] = useState(false);
  const leaveRef = useRef<() => Promise<boolean>>(async () => true);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    (async () => {
      // The project in the address (a shared link), else the last one opened.
      const id = Number(params.get("project")) || (await api.me()).last_project_id;
      setProjectId(id || null);
      setOverlay(params.has("projects") || !id);
    })().catch((error) => {
      if ((error as { status?: number }).status === 401)
        router.replace(`/?next=${encodeURIComponent(location.pathname + location.search)}`);
    });
  }, [router]);

  async function open(id: number | null, stay = false) {
    if (!(await leaveRef.current())) return;
    leaveRef.current = async () => true;
    // A new editor reads the address, so drop the old project's image link first.
    window.history.replaceState(null, "", id ? `/annotate?project=${id}` : "/annotate?projects");
    setProjectId(id);
    setGeneration((n) => n + 1);
    setOverlay(id === null || stay);
  }

  return (
    <>
      {projectId ? (
        <Editor
          key={`${projectId}:${generation}`}
          projectId={projectId}
          paused={overlay}
          leaveRef={leaveRef}
          onOpenProjects={async () => {
            // Saved first, before sharing changes in the overlay can move the edits to another
            // layer; a failed save stays in the editor with its error.
            if (await leaveRef.current()) setOverlay(true);
          }}
          onNoProject={() => void open(null)}
        />
      ) : (
        <main className="min-h-full bg-canvas" data-testid="annotate-app" />
      )}
      <Dialog open={overlay} onOpenChange={(o) => !o && projectId && setOverlay(false)}>
        <DialogContent
          data-testid="projects-overlay"
          className="max-w-3xl p-8 sm:p-10"
          // Grows into the projects page when expanded (see globals.css).
          style={{ viewTransitionName: "projects-card" }}
          aria-describedby={undefined}
        >
          {projectId !== undefined && (
            <ProjectsPanel
              currentId={projectId}
              onOpen={(p) => (p.id === projectId ? setOverlay(false) : void open(p.id))}
              onChanged={(p) => p.id === projectId && void open(p.id, true)}
              onDeleted={(id) => id === projectId && void open(null)}
              onExpand={async () => {
                if (await leaveRef.current()) router.push("/projects");
                else expanded.current = undefined;
              }}
              onClose={projectId ? () => setOverlay(false) : undefined}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
