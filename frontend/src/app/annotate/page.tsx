"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AiCursorStatus } from "@/components/AiCursorStatus";
import { BrushSizeControl } from "@/components/BrushSizeControl";
import PatchCanvas, { type AnnotatorApi } from "@/components/PatchCanvas";
import Sidebar from "@/components/Sidebar";
import ShortcutsDialog from "@/components/ShortcutsDialog";
import SlideMap from "@/components/SlideMap";
import { Button } from "@/components/ui/button";
import { Overlay } from "@/components/Overlay";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, type Element, type Job, type Me, type Patch, type ViewRect } from "@/lib/api";
import type { Tool } from "@/lib/draw";
import { createAnnotationSync } from "@/lib/annotation-sync";
import { useAi } from "@/lib/use-ai";
import { isTypingTarget } from "@/lib/keys";
import { parseShareLink, shareLinkQuery } from "@/lib/share-link";
import { TOOLS, useEnabledTools } from "@/lib/tools";

const FAILURE_MESSAGE_MS = 5000;

type Menu = "job" | "tool" | "size";

function errorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : "Something went wrong.";
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

export default function AnnotatePage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
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
  const jobIdRef = useRef<number | null>(null);
  const saveTimer = useRef<number>(0);
  const sync = useRef<ReturnType<typeof createAnnotationSync> | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The address bar already shows the fallback patch, so reloading cannot retry a failed link.
  const [linkFailed, setLinkFailed] = useState(false);
  const [brokenImage, setBrokenImage] = useState<number | null>(null);
  const ai = useAi(patch?.id, (elements, sourcePatchId) => {
    if (patchRef.current?.id === sourcePatchId) annoRef.current?.add(elements);
  });
  const pending = useMemo(
    () => ai.tasks.filter((t) => t.patch_id === patch?.id && t.status !== "failed"),
    [ai.tasks, patch?.id],
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
    jobIdRef.current = jobId;
  }, [patch, jobId]);

  const showPatch = useCallback((next: Patch, initial: ViewRect | null = null) => {
    patchRef.current = next;
    setInitialView(initial);
    annoRef.current = null;
    sync.current = createAnnotationSync(next.elements, (changes) => api.edit(next.id, changes));
    setOpenCount((n) => n + 1);
    setPatch(next);
    setMarks(next.elements);
    setSelectedId(null);
    setLoadError(null);
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
    async (load: () => Promise<Patch>) => {
      const seq = ++loadSeq.current;
      try {
        const next = await load();
        if (seq === loadSeq.current) showPatch(next);
      } catch (error) {
        if (seq === loadSeq.current) throw error;
      }
    },
    [showPatch],
  );

  useEffect(() => {
    (async () => {
      try {
        // Opening a link may switch the dataset, which changes the jobs and folder fetched below.
        const link = parseShareLink(window.location.search);
        let linkError: string | null = null;
        const opened = link
          ? await api
              .openImage(link.image, {
                folder_id: link.dataset,
                view: link.view,
              })
              .catch((error) => {
                if ((error as { status?: number }).status === 401) throw error;
                linkError = errorMessage(error);
                return null;
              })
          : null;
        const [who, jobList] = await Promise.all([api.me(), api.jobs()]);
        setMe(who);
        setJobs(jobList);
        const job = jobList.find((j) => j.id === who.last_job_id)?.id ?? jobList[0]?.id ?? null;
        setJobId(job);
        if (job != null && job !== who.last_job_id) setMe(await api.setJob(job));
        setFolderId(who.last_folder_id);
        if (link && opened) {
          const { left, top } = opened.image;
          // The patch carries the job from before the remap above.
          showPatch(
            { ...opened, job_id: job },
            {
              ...link.view,
              left: link.view.left - left,
              top: link.view.top - top,
            },
          );
        } else await loadLatest(api.currentPatch);
        if (linkError) {
          setLoadError(`Could not open the shared image: ${linkError}`);
          setLinkFailed(true);
        }
      } catch (error) {
        if ((error as { status?: number }).status === 401)
          router.replace(`/?next=${encodeURIComponent(location.pathname + location.search)}`);
        else setLoadError(errorMessage(error));
      }
    })();
  }, [loadLatest, showPatch, router]);

  // The address bar always links to the open image and the visible area.
  useEffect(() => {
    if (!patch) return;
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
    window.history.replaceState(null, "", `/annotate?${query}`);
  }, [patch, view, initialView]);

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
      setSaveError("Changes could not be saved. Please retry before leaving.");
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
      const jobList = await api.jobs();
      setJobs(jobList);
      const nextId = jobList.find((j) => j.id === jobIdRef.current)?.id ?? jobList[0]?.id;
      if (nextId != null && nextId !== jobIdRef.current) await switchJob(nextId);
      await loadLatest(api.currentPatch);
    } catch (error) {
      setLoadError(`Could not switch datasets. ${errorMessage(error)}`);
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
    keyHandler.current = (e: KeyboardEvent) => {
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

  if (!me || jobId == null) {
    return (
      <main className="flex min-h-full items-center justify-center text-sm text-muted-foreground">
        {loadError ? <LoadError message={loadError} /> : "Loading"}
      </main>
    );
  }

  const sidebar = (
    <Sidebar
      me={me}
      jobs={jobs}
      folderId={folderId}
      patch={patch}
      loadFailed={!patch && !!loadError}
      marks={marks}
      selectedId={selectedId}
      onUseFolder={(id) => void switchFolder(id)}
      onOpenImage={(id) => void go(() => api.openImage(id))}
      onStains={setStains}
      onHoverMark={(id) => annoRef.current?.highlight(id)}
      onSelectMark={selectMark}
      onDeleteMark={(id) => annoRef.current?.remove(id)}
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
            jobs={jobs}
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
              {saveError}{" "}
              <button className="underline" onClick={() => void persist().catch(() => {})}>
                Retry save
              </button>
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
                  {jobs.map((j) => (
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
