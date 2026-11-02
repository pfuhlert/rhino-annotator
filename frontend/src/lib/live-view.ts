import { useSyncExternalStore } from "react";
import type { ViewRect } from "./api";

// The on-screen part of the open patch, updated every frame. Only the slide map's view box
// subscribes, so panning never re-renders the annotate page.
let current: { tileUrl: string; rect: ViewRect } | null = null;
const listeners = new Set<() => void>();

export function setLiveView(tileUrl: string, rect: ViewRect) {
  current = { tileUrl, rect };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLiveView(tileUrl: string) {
  const live = useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
  return live?.tileUrl === tileUrl ? live.rect : null;
}
