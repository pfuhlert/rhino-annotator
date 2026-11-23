// Histology slides or electron microscopy (ELMI); each image and label class is one or the other.
export type Kind = "histo" | "elmi";
// Mask classes are drawn on the image; score classes give each image one 0-100 value.
export type Mode = "mask" | "score";
export type Job = { id: number; name: string; color: string; kind: Kind; mode: Mode };
// A score class's value on an image: 0-100, or "na" when the image is not scorable.
export type ScoreValue = number | "na";
// Score class id -> value; classes without a value are missing.
export type Scores = Record<string, ScoreValue>;
// in_project: one of the project's label classes; the others only name and color old annotations.
export type ProjectJob = Job & { in_project: boolean };
export type Visibility = "private" | "people" | "everyone";
export type ProjectFolder = { id: string; path: string; kind: Kind };
export type Project = {
  id: number;
  name: string;
  visibility: Visibility;
  owner: string | null;
  is_owner: boolean;
  // Annotations here are the project's shared layer rather than the user's own.
  shared_layer: boolean;
  has_layer: boolean;
  folders: ProjectFolder[];
  jobs: Job[];
  members: string[];
  // null without folders (any folder), while they are indexed, or when listing one failed.
  image_count: number | null;
  annotation_count: number | null;
  my_annotation_count: number | null;
  // Why a folder's images could not be listed; the counts wait for it to be refreshed.
  listing_error: string | null;
  opened: number | null;
};
export type ProjectInput = {
  name?: string;
  folders?: string[];
  // Without an id, a new label class.
  jobs?: (Omit<Job, "id"> & { id?: number })[];
};
export type Me = {
  id: number;
  username: string;
  last_job_id: number | null;
  last_folder_id: string | null;
  last_project_id: number | null;
  // null selects images without a stain.
  stain_filter: (string | null)[];
  // null selects images without a magnification.
  mag_filter: (number | null)[];
  // Whether histology slides open as tissue regions unless set per slide.
  split_histo: boolean;
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
  // The top of a project's folders, which the sidebar cannot leave.
  root?: boolean;
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
  // A histology slide shown whole: its one tile is the slide, so only the view is drawn.
  whole: boolean;
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
  // Picks the label classes offered for this image.
  kind: Kind;
  job_id: number | null;
  folder_id: string;
  image: PatchImage;
  nm_per_px: number | null;
  elements: Element[];
  scores: Scores;
  // The masks of this image are finished: unmasked area holds none of the structures.
  complete: boolean;
  times: Times;
  // The elements are the project's shared layer; saves name it so a stale tab cannot write them
  // into another layer after sharing changed.
  shared_layer: boolean;
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
  complete: boolean;
  // Whether this user sees a histology slide split by tissue; null for other images and unopened
  // ones.
  split: boolean | null;
};
export const imageThumbnailUrl = (id: string, side: number) =>
  `/images/${encodeURIComponent(id)}/thumbnail?side=${side}`;
export type ImageCatalog = {
  // The browsed folder, or a project's key for all of its folders.
  folder_id: string;
  // The folders are being listed; items are empty until their first listing lands.
  indexing: boolean;
  // Why the last refresh failed; the items are the listing before it.
  listing_error: string | null;
  items: ImageRow[];
  stains: { name: string | null; count: number }[];
  magnifications: { value: number | null; count: number }[];
};

// The editor's project, named in every request so a second tab opening another project cannot
// redirect this one's saves.
let requestProject: number | null = null;
export function setRequestProject(id: number | null) {
  requestProject = id;
}
export function withProject(path: string) {
  if (requestProject === null) return path;
  return `${path}${path.includes("?") ? "&" : "?"}project=${requestProject}`;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(withProject(path), {
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
  setSplitHisto: (split_histo: boolean) =>
    req<Me>("/me", { method: "PATCH", body: JSON.stringify({ split_histo }) }),
  jobs: () => req<ProjectJob[]>("/jobs"),
  jobPresets: () => req<Record<Kind, Job[]>>("/jobs/presets"),
  // Scoped: limited to the current project's folders, as in the sidebar.
  folders: (parent_id?: string | null, scoped = false) => {
    const query = new URLSearchParams();
    if (parent_id) query.set("parent_id", parent_id);
    if (scoped) query.set("scoped", "true");
    return req<FolderLevel>(`/folders${query.size ? `?${query}` : ""}`);
  },
  resolveFolders: (folders: string[]) =>
    req<ProjectFolder[]>("/folders/resolve", {
      method: "POST",
      body: JSON.stringify({ folders }),
    }),
  projects: () => req<Project[]>("/api/projects"),
  createProject: (body: ProjectInput) =>
    req<Project>("/api/projects", { method: "POST", body: JSON.stringify(body) }),
  updateProject: (id: number, body: ProjectInput) =>
    req<Project>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteProject: (id: number) => req<{ ok: boolean }>(`/api/projects/${id}`, { method: "DELETE" }),
  shareProject: (id: number, visibility: Visibility, members: string[]) =>
    req<Project>(`/api/projects/${id}/sharing`, {
      method: "PUT",
      body: JSON.stringify({ visibility, members }),
    }),
  copyToLayer: (id: number) =>
    req<{ copied: number; project: Project }>(`/api/projects/${id}/copy-annotations`, {
      method: "POST",
    }),
  openProject: (id: number) => req<Project>(`/api/projects/${id}/open`, { method: "POST" }),
  currentPatch: () => req<Patch>("/patches/current"),
  nextPatch: () => req<Patch>("/patches/next"),
  prevPatch: () => req<Patch>("/patches/prev"),
  // split first sets whether this user sees a histology slide split by tissue or whole.
  openImage: (
    item_id: string,
    options?: { folder_id?: string; view?: ViewRect; split?: boolean },
  ) =>
    req<Patch>("/patches/open", { method: "POST", body: JSON.stringify({ item_id, ...options }) }),
  images: () => req<ImageCatalog>("/images"),
  refreshImages: () => req<{ ok: boolean }>("/images/refresh", { method: "POST" }),
  imagePath: (item_id: string) =>
    req<{ path: string }>(`/images/${encodeURIComponent(item_id)}/path`),
  setStains: (stain_filter: (string | null)[]) =>
    req<Me>("/me", { method: "PATCH", body: JSON.stringify({ stain_filter }) }),
  setMags: (mag_filter: (number | null)[]) =>
    req<Me>("/me", { method: "PATCH", body: JSON.stringify({ mag_filter }) }),
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
  setScore: (patchId: number, shared: boolean, job_id: number, value: ScoreValue) =>
    req<{ scores: Scores }>(`/patches/${patchId}/scores?shared=${shared}`, {
      method: "PUT",
      body: JSON.stringify({ job_id, value }),
    }),
  clearScore: (patchId: number, shared: boolean, jobId: number) =>
    req<{ scores: Scores }>(`/patches/${patchId}/scores/${jobId}?shared=${shared}`, {
      method: "DELETE",
    }),
  setComplete: (patchId: number, shared: boolean, complete: boolean) =>
    req<{ complete: boolean }>(
      `/patches/${patchId}/complete?complete=${complete}&shared=${shared}`,
      { method: "PUT" },
    ),
  edit: (patchId: number, shared: boolean, changes: { upsert: Element[]; delete: string[] }) =>
    req<{ times: Times }>(`/patches/${patchId}/annotations?shared=${shared}`, {
      method: "PATCH",
      body: JSON.stringify(changes),
    }),
};
