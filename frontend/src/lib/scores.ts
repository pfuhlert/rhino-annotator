import type { Job, ScoreValue } from "./api";

type Key = Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey">;

export type ScoreAction =
  | { kind: "set"; value: ScoreValue }
  | { kind: "next" }
  | { kind: "prev" }
  | { kind: "class"; step: 1 | -1 };

// A second digit typed within this time completes a two-digit score.
export const TWO_DIGIT_MS = 800;

// Digits score in tens (7 → 70); a second digit typed quickly makes a two-digit score
// (9 5 → 95, 0 5 → 5, 1 0 → 100). A held key's repeats are ignored.
export type DigitState = { digit: number; at: number } | null;

export function digitScore(
  digit: number,
  now: number,
  last: DigitState,
): { value: number; state: DigitState } {
  if (last && now - last.at <= TWO_DIGIT_MS) {
    const value = last.digit === 1 && digit === 0 ? 100 : last.digit * 10 + digit;
    return { value, state: null };
  }
  return { value: digit * 10, state: { digit, at: now } };
}

export function scoreKey(e: Key & { repeat?: boolean }): ScoreAction | number | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (/^[0-9]$/.test(e.key)) return e.repeat ? null : Number(e.key);
  switch (e.key) {
    case "x":
    case "X":
      return { kind: "set", value: "na" };
    case "Enter":
      return { kind: e.shiftKey ? "prev" : "next" };
    case "s":
    case "S":
      return { kind: "class", step: e.shiftKey ? -1 : 1 };
  }
  return null;
}

export const isScoreClass = (job: Pick<Job, "mode">) => job.mode === "score";

export function scoreLabel(value: ScoreValue | undefined) {
  return value === undefined ? "–" : value === "na" ? "N/A" : String(value);
}
