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

// New label classes take the first of these their project does not use yet.
export const LABEL_COLORS = [
  "#e11d48",
  "#2563eb",
  "#059669",
  "#d97706",
  "#7c3aed",
  "#0891b2",
  "#db2777",
  "#4f46e5",
  "#ca8a04",
  "#78716c",
];

export function nextColor(used: string[]) {
  const taken = new Set(used.map((c) => c.toLowerCase()));
  return LABEL_COLORS.find((c) => !taken.has(c)) ?? LABEL_COLORS[used.length % LABEL_COLORS.length];
}

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
export function pickerJobs(jobs: ProjectJob[], selectedId: number | null): Job[] {
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
