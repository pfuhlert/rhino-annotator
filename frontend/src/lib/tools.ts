import { useSyncExternalStore } from "react";
import type { Tool } from "./draw";

export const TOOLS: readonly (readonly [Tool, string, string])[] = [
  ["hand", "Hand", "H"],
  ["point", "Point", "P"],
  ["polygon", "Polygon", "L"],
  ["brush", "Brush", "R"],
  ["ai-box", "AI Box", "A"],
];

const KEY = "tools";
const CHANGE = "toolschange";
const TOOL_IDS = TOOLS.map(([id]) => id);
const DEFAULT = TOOL_IDS.filter((id) => id !== "hand");

// Keeps toolbar order and never leaves the user without a tool.
export function parseEnabledTools(raw: string | null): Tool[] {
  let ids: unknown;
  try {
    ids = JSON.parse(raw ?? "");
  } catch {}
  const enabled = Array.isArray(ids) ? TOOL_IDS.filter((id) => ids.includes(id)) : [];
  return enabled.length ? enabled : DEFAULT;
}

let cache: [string | null, Tool[]] = [null, DEFAULT];

function read() {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {}
  if (raw !== cache[0]) cache = [raw, parseEnabledTools(raw)];
  return cache[1];
}

function subscribe(onChange: () => void) {
  addEventListener(CHANGE, onChange);
  addEventListener("storage", onChange);
  return () => {
    removeEventListener(CHANGE, onChange);
    removeEventListener("storage", onChange);
  };
}

export function setToolEnabled(tool: Tool, on: boolean) {
  const current = read();
  const next = TOOL_IDS.filter((id) => (id === tool ? on : current.includes(id)));
  if (!next.length) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  dispatchEvent(new Event(CHANGE));
}

export const useEnabledTools = () => useSyncExternalStore(subscribe, read, () => DEFAULT);
