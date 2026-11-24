import type { Job, Kind, Project, ProjectFolder, ProjectInput, ProjectJob } from "./api";

export type Label = NonNullable<ProjectInput["jobs"]>[number];

export const KINDS: { kind: Kind; title: string }[] = [
  { kind: "histo", title: "Histology" },
  { kind: "elmi", title: "ELMI" },
];

// The image kinds a project's folders hold; without folders it may browse either.
export function folderKinds(folders: ProjectFolder[]): Kind[] {
  const present = new Set(folders.map((f) => f.kind));
  return KINDS.map((k) => k.kind).filter((k) => !folders.length || present.has(k));
}

// A kind the folders newly hold brings its preset classes; a kind they no longer hold drops the
// presets still in their preset color. Custom and recolored classes always stay.
export function adaptLabels(
  labels: Label[],
  before: Kind[],
  after: Kind[],
  presets: Record<Kind, Job[]>,
): Label[] {
  const key = (l: Label) => `${l.id}:${l.color.toLowerCase()}`;
  const dropped = new Set(
    before.filter((k) => !after.includes(k)).flatMap((k) => presets[k].map(key)),
  );
  const kept = labels.filter((l) => !dropped.has(key(l)));
  const ids = new Set(kept.map((l) => l.id));
  const added = after.filter((k) => !before.includes(k)).flatMap((k) => presets[k]);
  return [...kept, ...added.filter((j) => !ids.has(j.id))];
}

// New label classes take the one of these farthest from every color their project uses.
export const LABEL_COLORS = [
  "#e11d48",
  "#2563eb",
  "#059669",
  "#d97706",
  "#7c3aed",
  "#0891b2",
  "#78716c",
  "#00ff00",
  "#ff00ff",
  "#4a1d00",
];

// OKLab, where distance follows how different two colors look.
function oklab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.4072426305 * m - 0.646826849 * s,
  ];
}

export function colorDistance(a: string, b: string) {
  const [p, q] = [oklab(a), oklab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

export function nextColor(used: string[]) {
  const gap = (c: string) => Math.min(...used.map((u) => colorDistance(c, u)));
  return LABEL_COLORS.reduce((best, c) => (gap(c) > gap(best) ? c : best));
}

// Black or white, whichever reads better on a class's color.
export const textOn = (color: string) => (oklab(color)[0] > 0.7 ? "#000" : "#fff");

// Girder paths read "/collection/ELMI/Glomeruli"; the collection prefix is noise in the UI.
export function folderLabel(path: string) {
  return path
    .replace(/^\/(collection|user)\//, "")
    .split("/")
    .filter(Boolean)
    .join(" / ");
}

export type ProjectFilter = "all" | "private" | "shared";

export function matchesFilter(project: Project, filter: ProjectFilter) {
  if (filter === "all") return true;
  return (project.visibility === "private") === (filter === "private");
}

export function sharingLabel(project: Project) {
  if (project.visibility === "everyone") return "Shared · Everyone";
  if (project.visibility === "people") return `Shared · ${project.members.length + 1}`;
  return null;
}

// The picker offers the project's classes, plus the selected one when an old annotation from
// another class is being edited.
export function pickerJobs(jobs: ProjectJob[], selectedId: number | null): ProjectJob[] {
  return jobs.filter((j) => j.in_project || j.id === selectedId);
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86400],
  ["month", 30 * 86400],
  ["week", 7 * 86400],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function plural(n: number, word: string, many = `${word}s`) {
  return `${n.toLocaleString("en-US")} ${n === 1 ? word : many}`;
}

// "just now", "5 minutes ago", "yesterday", ...
export function timeAgo(seconds: number, nowMs: number) {
  const elapsed = Math.max(0, nowMs / 1000 - seconds);
  const [unit, size] = UNITS.find(([, s]) => elapsed >= s) ?? ["second", 1];
  return unit === "second" ? "just now" : relative.format(-Math.floor(elapsed / size), unit);
}

export function openedLabel(seconds: number | null, nowMs: number) {
  return seconds === null ? "Never opened" : `Opened ${timeAgo(seconds, nowMs)}`;
}
