export type Job = { id: number; name: string; color: string };
export type Me = { id: number; username: string; last_job_id: number | null; done_count: number };
export type Element = { type: "point" | "polygon"; points: number[][]; jobId: number };
export type Patch = {
  id: number;
  job_id: number | null;
  image_url: string;
  width: number;
  height: number;
  has_prev: boolean;
  elements: Element[];
};

const API = "";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
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
  jobs: () => req<Job[]>("/jobs"),
  currentPatch: () => req<Patch>("/patches/current"),
  nextPatch: () => req<Patch>("/patches/next"),
  prevPatch: () => req<Patch>("/patches/prev"),
  imageUrl: (patchId: number) => `${API}/patches/${patchId}/image`,
  async imageBlob(patchId: number): Promise<string> {
    const res = await fetch(api.imageUrl(patchId), { credentials: "include" });
    if (!res.ok) throw new Error("image failed");
    return URL.createObjectURL(await res.blob());
  },
  save: (patchId: number, job_id: number, elements: { type: string; points: number[][] }[]) =>
    req<{ id: number | null; last_job_id: number }>(`/patches/${patchId}/annotations`, {
      method: "POST",
      body: JSON.stringify({ job_id, elements }),
    }),
};
