import { useCallback, useEffect, useRef, useState } from "react";
import { aiTaskId, api, type AiPrompt, type AiTask, type AiWorkerState, type Element } from "./api";

export function useAi(
  patchId: number | undefined,
  onResult: (elements: Element[], patchId: number) => void,
) {
  const [tasks, setTasks] = useState<AiTask[]>([]);
  const [worker, setWorker] = useState<AiWorkerState>("offline");
  const local = useRef(new Map<string, AiTask>());
  const submitting = useRef(new Map<string, Promise<unknown>>());
  const cancelled = useRef(new Set<string>());
  const wake = useRef<(reset?: boolean) => void>(() => {});
  const result = useRef(onResult);
  useEffect(() => {
    result.current = onResult;
  });

  useEffect(() => {
    if (!patchId) return;
    const controller = new AbortController();
    const { signal } = controller;
    let running = false;
    let requested = false;
    let reset = false;
    let timer: ReturnType<typeof setTimeout>;
    let cursor = 0;
    async function poll() {
      if (running) {
        requested = true;
        return;
      }
      running = true;
      requested = false;
      if (reset) cursor = 0;
      reset = false;
      clearTimeout(timer);
      let delay = 1500;
      try {
        const status = await api.aiStatus(patchId!, cursor, signal);
        if (signal.aborted) return;
        const elements = status.elements.filter((el) => {
          const id = aiTaskId(el.id);
          if (!id) return false;
          local.current.delete(id);
          return !cancelled.current.has(id);
        });
        if (!reset) cursor = Math.max(cursor, status.cursor);
        setWorker(status.worker);
        for (const task of status.tasks) local.current.delete(task.id);
        const merged = new Map(status.tasks.map((task) => [task.id, task]));
        for (const [id, task] of local.current) if (!merged.has(id)) merged.set(id, task);
        const next = [...merged.values()].filter((task) => !cancelled.current.has(task.id));
        setTasks((previous) =>
          previous.length === next.length &&
          previous.every(
            (t, i) =>
              t.id === next[i].id && t.status === next[i].status && t.error === next[i].error,
          )
            ? previous
            : next,
        );
        if (elements.length) result.current(elements, patchId!);
        if (next.some((task) => task.status !== "failed")) delay = 200;
      } catch {
        if (!signal.aborted) setWorker("offline");
      } finally {
        running = false;
        if (!signal.aborted) timer = setTimeout(poll, requested ? 0 : delay);
      }
    }
    wake.current = (rewind = false) => {
      reset ||= rewind;
      void poll();
    };
    void poll();
    return () => {
      controller.abort();
      wake.current = () => {};
      clearTimeout(timer);
    };
  }, [patchId]);

  const submit = useCallback((patch: number, job: number, prompt: AiPrompt) => {
    const task: AiTask = {
      id: crypto.randomUUID(),
      patch_id: patch,
      job_id: job,
      ...prompt,
      status: "queued",
      error: null,
    };
    local.current.set(task.id, task);
    setTasks((previous) => [...previous, task]);
    const request = api
      .aiSubmit(patch, { id: task.id, job_id: job, ...prompt })
      .then((saved) => {
        if (local.current.has(task.id)) local.current.set(task.id, saved);
        wake.current();
        setTasks((previous) => previous.map((t) => (t.id === task.id ? saved : t)));
      })
      .catch((error) => {
        const failed = { ...task, status: "failed", error: String(error.message || error) };
        local.current.set(task.id, failed);
        setTasks((previous) => previous.map((t) => (t.id === task.id ? failed : t)));
      })
      .finally(() => submitting.current.delete(task.id));
    submitting.current.set(task.id, request);
  }, []);

  const cancel = useCallback(async (id: string) => {
    cancelled.current.add(id);
    setTasks((previous) => previous.filter((t) => t.id !== id));
    await submitting.current.get(id);
    try {
      await api.aiCancel(id);
      local.current.delete(id);
    } catch (error) {
      if ((error as { status?: number }).status === 404) local.current.delete(id);
      else {
        cancelled.current.delete(id);
        wake.current(true);
        return false;
      }
    }
    return true;
  }, []);

  return { tasks, worker, submit, cancel };
}
