import { useSyncExternalStore } from "react";

const KEY = "fillOpacity";
const CHANGE = "fillopacitychange";
const DEFAULT = 0.08;
export const MIN_FILL_OPACITY = 0.05;

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? Math.min(1, Math.max(MIN_FILL_OPACITY, n)) : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

function subscribe(onChange: () => void) {
  addEventListener(CHANGE, onChange);
  addEventListener("storage", onChange);
  return () => {
    removeEventListener(CHANGE, onChange);
    removeEventListener("storage", onChange);
  };
}

export function setFillOpacity(opacity: number) {
  try {
    localStorage.setItem(KEY, String(opacity));
  } catch {}
  dispatchEvent(new Event(CHANGE));
}

export const useFillOpacity = () => useSyncExternalStore(subscribe, read, () => DEFAULT);
