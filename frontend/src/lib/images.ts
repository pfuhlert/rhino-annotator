import type { ImageRow, Patch } from "@/lib/api";

export type ImageGroup = { name: string; rows: ImageRow[]; done: number; mark: Mark | null };

// Opening an image already visits its first region, so annotated is the stronger mark.
export type Mark = "annotated" | "visited";

export const rowMark = (row: ImageRow): Mark | null =>
  row.annotations ? "annotated" : row.visited ? "visited" : null;

export const strongest = (marks: (Mark | null)[]): Mark | null =>
  marks.includes("annotated") ? "annotated" : marks.includes("visited") ? "visited" : null;

export const isDone = (row: ImageRow) => row.regions !== null && row.visited >= row.regions;

// Region progress and layout of the open slide come from its patch, so the list needs no refetch
// per region or layout switch. Without a slide view (images shown whole) the fetched row's
// progress is the source of truth.
function withProgress(row: ImageRow, patch: Patch | null): ImageRow {
  if (patch?.item_id !== row.id) return row;
  const split = row.split === null ? null : !patch.slide?.whole;
  const tiles = patch.slide?.tiles;
  if (!tiles) return { ...row, split };
  return { ...row, split, regions: tiles.length, visited: tiles.filter((t) => t[4]).length };
}

// Rows arrive sorted by group, so consecutive rows with the same group form one group.
export function groupImages(
  rows: ImageRow[],
  stains: (string | null)[],
  patch: Patch | null,
  mags: (number | null)[] = [],
): ImageGroup[] {
  const groups: ImageGroup[] = [];
  for (const item of rows) {
    if (stains.length && !stains.includes(item.staining)) continue;
    if (mags.length && !mags.includes(item.magnification)) continue;
    const row = withProgress(item, patch);
    let group = groups.at(-1);
    if (group?.name !== row.group)
      groups.push((group = { name: row.group, rows: [], done: 0, mark: null }));
    group.rows.push(row);
    if (isDone(row)) group.done++;
    group.mark = strongest([group.mark, rowMark(row)]);
  }
  return groups;
}
