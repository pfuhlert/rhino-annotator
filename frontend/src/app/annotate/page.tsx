"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { BrushSizeControl } from "@/components/BrushSizeControl";
import PatchCanvas, { type AnnotatorApi } from "@/components/PatchCanvas";
import FolderPicker from "@/components/FolderPicker";
import { Button } from "@/components/ui/button";
import { Overlay, OverlayTrigger } from "@/components/Overlay";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, type Job, type Me, type Patch } from "@/lib/api";
import type { Tool } from "@/lib/draw";
import { isTypingTarget } from "@/lib/keys";

const TOOLS = [
  ["point", "Point (P)"],
  ["polygon", "Polygon (L)"],
  ["brush", "Brush (R)"],
] as const;
const TOOL_IDS = TOOLS.map(([id]) => id);

type Menu = "job" | "tool" | "size";

export default function AnnotatePage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobId, setJobId] = useState<number | null>(null);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [patch, setPatch] = useState<Patch | null>(null);
  const [tool, setTool] = useState<Tool>("polygon");
  const [brushRadius, setBrushRadius] = useState(16);
  const [openMenu, setOpenMenu] = useState<Menu | null>(null);
  const [busy, setBusy] = useState(false);
  const toggleMenu = (id: Menu) => (open: boolean) =>
    setOpenMenu(open ? id : (cur) => (cur === id ? null : cur));
  const annoRef = useRef<AnnotatorApi | null>(null);
  const patchRef = useRef<Patch | null>(null);
  const jobIdRef = useRef<number | null>(null);
  const saveTimer = useRef<number>(0);
  const jobsOnPatch = useRef<Set<number>>(new Set());

  useEffect(() => {
    patchRef.current = patch;
    jobIdRef.current = jobId;
  }, [patch, jobId]);

  const showPatch = useCallback((next: Patch) => {
    setPatch(next);
    if (next.job_id) setJobId(next.job_id);
    if (next.folder_id) setFolderId(next.folder_id);
    jobsOnPatch.current = new Set(next.elements.map((e) => e.jobId));
    if (next.job_id) jobsOnPatch.current.add(next.job_id);
  }, []);

  const loadPatch = useCallback(
    async (which: "current" | "next" | "prev") => {
      const next =
        which === "prev"
          ? await api.prevPatch()
          : which === "next"
            ? await api.nextPatch()
            : await api.currentPatch();
      showPatch(next);
    },
    [showPatch],
  );

  useEffect(() => {
    (async () => {
      try {
        const [who, jobList] = await Promise.all([api.me(), api.jobs()]);
        setMe(who);
        setJobs(jobList);
        setJobId(who.last_job_id ?? jobList[0]?.id ?? null);
        setFolderId(who.last_folder_id);
        await loadPatch("current");
      } catch {
        router.replace("/");
      }
    })();
  }, [loadPatch, router]);

  async function switchJob(id: number) {
    setJobId(id);
    setMe(await api.setJob(id));
  }

  async function persist() {
    const cur = patchRef.current;
    const jid = jobIdRef.current;
    if (!cur || jid == null) return;
    const marks = annoRef.current?.toElements() ?? [];
    const groups = new Map<number, typeof marks>();
    for (const mark of marks) {
      const list = groups.get(mark.jobId) || [];
      list.push(mark);
      groups.set(mark.jobId, list);
      jobsOnPatch.current.add(mark.jobId);
    }
    jobsOnPatch.current.add(jid);
    const allowed = new Set(jobs.map((j) => j.id));
    for (const id of jobsOnPatch.current) {
      if (!allowed.has(id)) continue;
      await api.save(
        cur.id,
        id,
        (groups.get(id) ?? []).map(({ type, points, holes }) =>
          holes?.length ? { type, points, holes } : { type, points },
        ),
      );
    }
    setMe(await api.me());
  }

  function queueSave() {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void persist(), 200);
  }

  const finish = useCallback(
    async (kind: "next" | "prev") => {
      if (!patch || jobId == null || busy) return;
      if (kind === "prev" && !patch.has_prev) return;
      setBusy(true);
      try {
        annoRef.current?.flush();
        window.clearTimeout(saveTimer.current);
        await persist();
        await loadPatch(kind);
      } finally {
        setBusy(false);
      }
    },
    [patch, jobId, busy, loadPatch],
  );

  async function switchFolder(id: string) {
    if (id === folderId || busy) return;
    setBusy(true);
    try {
      annoRef.current?.flush();
      window.clearTimeout(saveTimer.current);
      await persist();
      setFolderId(id);
      setMe(await api.setFolder(id));
      const jobList = await api.jobs();
      setJobs(jobList);
      const nextId = jobList.find((j) => j.id === jobIdRef.current)?.id ?? jobList[0]?.id;
      if (nextId != null && nextId !== jobIdRef.current) await switchJob(nextId);
      await loadPatch("current");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "tab") {
        e.preventDefault();
        const dir = e.shiftKey ? -1 : 1;
        setTool((cur) => TOOL_IDS[(TOOL_IDS.indexOf(cur) + dir + TOOL_IDS.length) % TOOL_IDS.length]);
        return;
      }
      if (k === "p") setTool("point");
      if (k === "l") setTool("polygon");
      if (k === "r") setTool("brush");
      if ((k === "z" || k === "y") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (k === "y" || e.shiftKey) annoRef.current?.redo();
        else annoRef.current?.undo();
      }
      if (e.metaKey || e.ctrlKey) return;
      if (k === "n" || k === "f") void finish("next");
      if (k === "b" || k === "arrowleft") void finish("prev");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finish]);

  if (!me || !patch || jobId == null) {
    return (
      <main className="flex min-h-full items-center justify-center text-sm text-muted-foreground">
        Loading
      </main>
    );
  }

  return (
    <Overlay
      sidebar={
        <>
          <div className="flex items-center p-2 pb-0">
            <span className="size-(--overlay-trigger-size) shrink-0" aria-hidden />
            <OverlayTrigger />
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-auto [scrollbar-width:none]">
            <div className="flex w-full min-w-0 flex-col p-2 pt-0">
              <div className="flex h-8 shrink-0 items-center px-2 text-xs font-medium text-sidebar-foreground/70">
                Select a dataset:
              </div>
              <div className="w-full text-sm">
                <FolderPicker selectedId={folderId} onUse={(id) => void switchFolder(id)} />
              </div>
            </div>
          </div>
          <div className="flex w-full items-center justify-between p-2">
            <div className="flex min-w-0 items-baseline gap-2 px-2">
              <div className="truncate text-sm font-medium">{me.username}</div>
              <div className="shrink-0 text-xs text-muted-foreground">{me.done_count} done</div>
            </div>
            <Button
              data-testid="logout"
              variant="ghost"
              size="sm"
              onClick={async () => {
                await api.logout();
                router.replace("/");
              }}
            >
              Log out
            </Button>
          </div>
        </>
      }
    >
      <main data-testid="annotate-app" className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-black">
        <PatchCanvas
          key={patch.id}
          src={patch.image_url}
          jobId={jobId}
          jobs={jobs}
          marks={patch.elements}
          tool={tool}
          radius={brushRadius}
          onRadiusChange={setBrushRadius}
          onReady={(a) => {
            annoRef.current = a;
          }}
          onChange={queueSave}
        />
        <footer className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/70 to-transparent px-4 py-4">
          <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-2">
            <Button
              data-testid="prev"
              variant="outline"
              disabled={busy || !patch.has_prev}
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
              <SelectTrigger data-testid="job-switcher" aria-label="Job">
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
              onValueChange={(id) => setTool(id as (typeof TOOLS)[number][0])}
            >
              <SelectTrigger data-testid="tool-switcher" aria-label="Tool">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="center" side="top">
                {TOOLS.map(([id, label]) => (
                  <SelectItem key={id} value={id} data-testid={`tool-${id}`}>
                    {label}
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
            <Button data-testid="undo" variant="outline" onClick={() => annoRef.current?.undo()}>
              Undo (Ctrl+Z)
            </Button>
            <Button data-testid="redo" variant="outline" onClick={() => annoRef.current?.redo()}>
              Redo (Ctrl+Y)
            </Button>
            <Button data-testid="next" disabled={busy} onClick={() => void finish("next")}>
              Next (N)
            </Button>
          </div>
        </footer>
      </main>
    </Overlay>
  );
}
