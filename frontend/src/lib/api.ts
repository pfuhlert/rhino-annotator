export type Job = { id: number; name: string; color: string };
export type Me = {
  id: number;
  username: string;
  last_job_id: number | null;
  last_folder_id: string | null;
  done_count: number;
};
export type FolderChild = {
  id: string;
  name: string;
  n_items: number;
  n_folders: number;
};
export type FolderLevel = {
  id: string | null;
  name: string;
  parent_id: string | null;
  n_items: number;
  children: FolderChild[];
};
const AI_ELEMENT_PREFIX = "ai-";
export function aiTaskId(elementId: string): string | null {
  return elementId.startsWith(AI_ELEMENT_PREFIX) ? elementId.slice(AI_ELEMENT_PREFIX.length) : null;
}

export type AiWorkerState = "offline" | "loading" | "ready";
export type Box = [number, number, number, number];
export type AiPrompt = { x: number; y: number; box?: never } | { box: Box; x?: never; y?: never };
export type AiTask = AiPrompt & {
  id: string;
  patch_id: number;
  job_id: number;
  status: string;
  error: string | null;
};
export type Element = {
  id: string;
  type: "point" | "polygon";
  points: [number, number][];
  holes?: [number, number][][];
  jobId: number;
};
export type Patch = {
  id: number;
  job_id: number | null;
  folder_id: string;
  image_url: string;
  nm_per_px: number | null;
  has_prev: boolean;
  elements: Element[];
};

export type Visit = { id: number; patch_id: number; n_annotations: number };

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      message = JSON.parse(text).detail || text;
    } catch {}
    throw Object.assign(new Error(message || res.statusText), { status: res.status });
  }
  return res.json() as Promise<T>;
}

export const api = {
  register: (username: string, password: string) =>
    req<Me>("/auth/register", { method: "POST", body: JSON.stringify({ username, password }) }),
  login: (username: string, password: string) =>
    req<Me>("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => req<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  me: () => req<Me>("/me"),
  setJob: (last_job_id: number) =>
    req<Me>("/me", { method: "PATCH", body: JSON.stringify({ last_job_id }) }),
  setFolder: (last_folder_id: string) =>
    req<Me>("/me", { method: "PATCH", body: JSON.stringify({ last_folder_id }) }),
  jobs: () => req<Job[]>("/jobs"),
  folders: (parent_id?: string | null) =>
    req<FolderLevel>(`/folders${parent_id ? `?parent_id=${encodeURIComponent(parent_id)}` : ""}`),
  currentPatch: () => req<Patch>("/patches/current"),
  nextPatch: () => req<Patch>("/patches/next"),
  prevPatch: () => req<Patch>("/patches/prev"),
  visits: () => req<Visit[]>("/patches/visits"),
  openVisit: (id: number) => req<Patch>(`/patches/visits/${id}`),
  aiStatus: (patchId: number, after = 0, signal?: AbortSignal) =>
    req<{
      cursor: number;
      worker: AiWorkerState;
      tasks: AiTask[];
      elements: Element[];
    }>(`/patches/ai?patch_id=${patchId}&after=${after}`, { signal }),
  aiSubmit: (patchId: number, prompt: AiPrompt & { id: string; job_id: number }) =>
    req<AiTask>(`/patches/${patchId}/ai`, { method: "POST", body: JSON.stringify(prompt) }),
  aiCancel: (id: string) => req(`/patches/ai/${id}`, { method: "DELETE" }),
  edit: (patchId: number, changes: { upsert: Element[]; delete: string[] }) =>
    req(`/patches/${patchId}/annotations`, { method: "PATCH", body: JSON.stringify(changes) }),
};
