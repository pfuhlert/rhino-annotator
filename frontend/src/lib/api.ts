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
export type Element = {
  type: "point" | "polygon";
  points: number[][];
  holes?: number[][][];
  jobId: number;
};
export type Patch = {
  id: number;
  job_id: number | null;
  folder_id: string;
  image_url: string;
  has_prev: boolean;
  elements: Element[];
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
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
  save: (patchId: number, job_id: number, elements: { type: string; points: number[][]; holes?: number[][][] }[]) =>
    req<{ id: number | null; last_job_id: number }>(`/patches/${patchId}/annotations`, {
      method: "POST",
      body: JSON.stringify({ job_id, elements }),
    }),
};
