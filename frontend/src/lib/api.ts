export type Job = { id: number; name: string; color: string };
export type Me = {
  id: number;
  username: string;
  last_job_id: number | null;
  last_folder_id: string | null;
  // null selects images without a stain.
  stain_filter: (string | null)[];
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
// Annotation id -> [created, updated] in epoch seconds; null when saved before timestamps existed.
export type Times = Record<string, [number | null, number | null]>;
export type Element = {
  id: string;
  type: "point" | "polygon";
  points: [number, number][];
  holes?: [number, number][][];
  jobId: number;
};
// [left, top, width, height, visited] in slide pixels.
export type SlideTile = [number, number, number, number, boolean];
export type SlideView = {
  name: string;
  width: number;
  height: number;
  thumbnail_url: string;
  tiles: SlideTile[];
  current: number;
};
// A patch is a rectangle of a slide pyramid; tile_url serves the slide's tiles (not the patch's).
export type PatchImage = {
  width: number;
  height: number;
  left: number;
  top: number;
  slide_width: number;
  slide_height: number;
  tile_width: number;
  tile_height: number;
  levels: number;
  tile_url: string;
  // Large regions prepare AI embeddings for the visible area instead of all at once.
  prepare_view: boolean;
};
export type ViewRect = { left: number; top: number; width: number; height: number };
export type Patch = {
  id: number;
  item_id: string;
  job_id: number | null;
  folder_id: string;
  image: PatchImage;
  nm_per_px: number | null;
  elements: Element[];
  times: Times;
  slide: SlideView | null;
};

export type ImageRow = {
  id: string;
  name: string;
  group: string;
  staining: string | null;
  magnification: number | null;
  // null until the image has been opened and split into regions.
  regions: number | null;
  visited: number;
  annotations: number;
};
export const imageThumbnailUrl = (id: string, side: number) =>
  `/images/${encodeURIComponent(id)}/thumbnail?side=${side}`;
export type ImageCatalog = {
  items: ImageRow[];
  stains: { name: string | null; count: number }[];
};

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
  openImage: (item_id: string, link?: { folder_id: string; view: ViewRect }) =>
    req<Patch>("/patches/open", { method: "POST", body: JSON.stringify({ item_id, ...link }) }),
  images: () => req<ImageCatalog>("/images"),
  imagePath: (item_id: string) =>
    req<{ path: string }>(`/images/${encodeURIComponent(item_id)}/path`),
  setStains: (stain_filter: (string | null)[]) =>
    req<Me>("/me", { method: "PATCH", body: JSON.stringify({ stain_filter }) }),
  prepare: (patchId: number, view: ViewRect) =>
    req<{ ok: boolean }>(`/patches/${patchId}/prepare`, {
      method: "POST",
      body: JSON.stringify(view),
    }),
  aiStatus: (patchId: number, after = 0, signal?: AbortSignal) =>
    req<{
      cursor: number;
      worker: AiWorkerState;
      tasks: AiTask[];
      elements: Element[];
      times: Times;
    }>(`/patches/ai?patch_id=${patchId}&after=${after}`, { signal }),
  aiSubmit: (patchId: number, prompt: AiPrompt & { id: string; job_id: number }) =>
    req<AiTask>(`/patches/${patchId}/ai`, { method: "POST", body: JSON.stringify(prompt) }),
  aiCancel: (id: string) => req(`/patches/ai/${id}`, { method: "DELETE" }),
  edit: (patchId: number, changes: { upsert: Element[]; delete: string[] }) =>
    req<{ times: Times }>(`/patches/${patchId}/annotations`, {
      method: "PATCH",
      body: JSON.stringify(changes),
    }),
};
