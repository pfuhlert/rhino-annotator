"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import PatchCanvas, { type AnnotatorApi } from "@/components/PatchCanvas";
import { api, type Job, type Me, type Patch } from "@/lib/api";

export default function AnnotatePage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobId, setJobId] = useState<number | null>(null);
  const [patch, setPatch] = useState<Patch | null>(null);
  const [src, setSrc] = useState("");
  const [tool, setTool] = useState<"point" | "polygon">("polygon");
  const [busy, setBusy] = useState(false);
  const annoRef = useRef<AnnotatorApi | null>(null);
  const patchRef = useRef<Patch | null>(null);
  const jobIdRef = useRef<number | null>(null);
  const saveTimer = useRef<number>(0);
  const jobsOnPatch = useRef<Set<number>>(new Set());

  useEffect(() => {
    patchRef.current = patch;
    jobIdRef.current = jobId;
  }, [patch, jobId]);

  const showPatch = useCallback(async (next: Patch) => {
    const url = await api.imageBlob(next.id);
    setPatch(next);
    setSrc((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return url;
    });
    if (next.job_id) setJobId(next.job_id);
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
      await showPatch(next);
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
        await loadPatch("current");
      } catch {
        router.replace("/");
      }
    })();
  }, [loadPatch, router]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const k = e.key.toLowerCase();
      if (k === "p") setTool("point");
      if (k === "l") setTool("polygon");
      if (k === "z" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        annoRef.current?.undo();
      }
      if (k === "n" || k === "f") void finish("next");
      if (k === "b" || k === "arrowleft") void finish("prev");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

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
    }
    for (const mark of marks) jobsOnPatch.current.add(mark.jobId);
    jobsOnPatch.current.add(jid);
    for (const id of jobsOnPatch.current) {
      const group = groups.get(id) ?? [];
      await api.save(
        cur.id,
        id,
        group.map(({ type, points }) => ({ type, points })),
      );
    }
    setMe(await api.me());
  }

  function queueSave() {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void persist(), 200);
  }

  async function finish(kind: "next" | "prev") {
    if (!patch || jobId == null || busy) return;
    if (kind === "prev" && !patch.has_prev) return;
    setBusy(true);
    window.clearTimeout(saveTimer.current);
    try {
      await persist();
      setMe(await api.me());
      await loadPatch(kind);
    } finally {
      setBusy(false);
    }
  }

  if (!me || !patch || !src || jobId == null) {
    return (
      <main className="flex min-h-full items-center justify-center text-sm text-zinc-500">
        Loading
      </main>
    );
  }

  const job = jobs.find((j) => j.id === jobId);

  return (
    <main data-testid="annotate-app" className="relative h-dvh overflow-hidden bg-black">
      <PatchCanvas
        key={src}
        src={src}
        jobId={jobId}
        jobs={jobs}
        marks={patch.elements}
        tool={tool}
        onReady={(a) => {
          annoRef.current = a;
        }}
        onChange={queueSave}
      />

      <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-4 bg-gradient-to-b from-black/70 to-transparent px-4 py-3">
        <div className="pointer-events-auto flex items-center gap-3">
          <span className="text-sm font-medium">{me.username}</span>
          <span className="text-xs text-zinc-400">{me.done_count} done</span>
        </div>
        <label className="pointer-events-auto flex items-center gap-2 text-sm">
          <span className="text-zinc-400">Job</span>
          <select
            data-testid="job-switcher"
            aria-label="Job"
            className="rounded-lg border border-zinc-700 bg-zinc-900/90 px-3 py-1.5"
            value={jobId}
            onChange={(e) => void switchJob(Number(e.target.value))}
          >
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.name}
              </option>
            ))}
          </select>
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: job?.color }} />
        </label>
        <button
          className="pointer-events-auto text-xs text-zinc-400 hover:text-zinc-100"
          onClick={async () => {
            await api.logout();
            router.replace("/");
          }}
        >
          Log out
        </button>
      </header>

      <footer className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-wrap items-center justify-center gap-2 bg-gradient-to-t from-black/70 to-transparent px-4 py-4">
        <button
          data-testid="tool-point"
          aria-pressed={tool === "point"}
          onClick={() => setTool("point")}
          className={`pointer-events-auto rounded-lg px-3 py-1.5 text-sm ${tool === "point" ? "bg-zinc-100 text-zinc-950" : "border border-zinc-600 bg-zinc-900/80"}`}
        >
          Point (P)
        </button>
        <button
          data-testid="tool-polygon"
          aria-pressed={tool === "polygon"}
          onClick={() => setTool("polygon")}
          className={`pointer-events-auto rounded-lg px-3 py-1.5 text-sm ${tool === "polygon" ? "bg-zinc-100 text-zinc-950" : "border border-zinc-600 bg-zinc-900/80"}`}
        >
          Polygon (L)
        </button>
        <button
          data-testid="undo"
          onClick={() => annoRef.current?.undo()}
          className="pointer-events-auto rounded-lg border border-zinc-600 bg-zinc-900/80 px-3 py-1.5 text-sm"
        >
          Undo
        </button>
        <button
          data-testid="prev"
          disabled={busy || !patch.has_prev}
          onClick={() => void finish("prev")}
          className="pointer-events-auto rounded-lg border border-zinc-600 bg-zinc-900/80 px-3 py-1.5 text-sm"
        >
          Previous (B)
        </button>
        <button
          data-testid="next"
          disabled={busy}
          onClick={() => void finish("next")}
          className="pointer-events-auto rounded-lg bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-950"
        >
          Next (N)
        </button>
      </footer>
    </main>
  );
}
