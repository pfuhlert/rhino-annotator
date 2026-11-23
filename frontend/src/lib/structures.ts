// Number keys pick a structure (mask class) in the Masks view: 1–9, then 0 for the tenth.
export function structureIndex(key: string, count: number): number | null {
  if (!/^[0-9]$/.test(key)) return null;
  const index = key === "0" ? 9 : Number(key) - 1;
  return index < count ? index : null;
}

// The number shown next to a structure, or null past the tenth.
export const structureKeyLabel = (index: number) =>
  index < 9 ? String(index + 1) : index === 9 ? "0" : null;

export type EditorMode = "masks" | "scores";

// Projects with only one kind of class have only that view.
export function editorMode(chosen: EditorMode, hasMasks: boolean, hasScores: boolean): EditorMode {
  if (!hasScores) return "masks";
  if (!hasMasks) return "scores";
  return chosen;
}
