import { useSyncExternalStore } from "react";
import { CHANGE, KEY } from "@/lib/theme-script";

export type Theme = "light" | "dark" | "system";

function read(): Theme {
  try {
    const theme = localStorage.getItem(KEY);
    return theme === "light" || theme === "dark" ? theme : "system";
  } catch {
    return "system";
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

export function setTheme(theme: Theme) {
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {}
  dispatchEvent(new Event(CHANGE));
}

export const useTheme = () => useSyncExternalStore(subscribe, read, () => "system" as const);
