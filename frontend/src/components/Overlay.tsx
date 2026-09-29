"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { PanelLeftIcon, PinIcon, PinOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

const PIN_KEY = "sidebar-pinned";
const EDGE_PX = 8;
const PEEK_CLOSE_MS = 300;

type OverlayState = { toggle: () => void; pinned: boolean; togglePin: () => void };
const OverlayCtx = createContext<OverlayState | null>(null);

function readPinned() {
  try {
    return localStorage.getItem(PIN_KEY) === "1";
  } catch {
    return false;
  }
}

export function Overlay({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState<"closed" | "peek" | "open">("open");
  const [pinned, setPinned] = useState(readPinned);
  const panelRef = useRef<HTMLDivElement>(null);
  const expanded = pinned || open !== "closed";

  useEffect(() => {
    if (!expanded || pinned) return;
    const outside = (e: Event) => {
      const el = e.target as Element | null;
      if (el?.closest("[data-slot=overlay-panel],[data-slot=sidebar-trigger]")) return;
      setOpen("closed");
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("wheel", outside, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("wheel", outside);
    };
  }, [expanded, pinned]);

  useEffect(() => {
    if (pinned || open === "open") return;
    let timer = 0;
    const move = (e: PointerEvent) => {
      if (open === "closed") {
        if (e.buttons === 0 && e.clientX <= EDGE_PX) setOpen("peek");
        return;
      }
      const right = panelRef.current?.getBoundingClientRect().right ?? 0;
      if (e.clientX <= right) {
        window.clearTimeout(timer);
        timer = 0;
      } else if (!timer) {
        timer = window.setTimeout(() => setOpen("closed"), PEEK_CLOSE_MS);
      }
    };
    window.addEventListener("pointermove", move);
    return () => {
      window.removeEventListener("pointermove", move);
      window.clearTimeout(timer);
    };
  }, [open, pinned]);

  function togglePin() {
    const next = !pinned;
    setPinned(next);
    setOpen("open");
    try {
      localStorage.setItem(PIN_KEY, next ? "1" : "0");
    } catch {}
  }

  const state: OverlayState = {
    toggle: () => (pinned ? togglePin() : setOpen(expanded ? "closed" : "open")),
    pinned,
    togglePin,
  };

  return (
    <OverlayCtx.Provider value={state}>
      <div
        data-slot="overlay"
        data-state={expanded ? "expanded" : "collapsed"}
        data-pinned={pinned || undefined}
        className="flex h-dvh min-h-0 w-full"
      >
        <div
          ref={panelRef}
          data-slot="overlay-panel"
          className="fixed inset-y-0 left-0 z-20 flex h-svh w-(--overlay-width) text-sidebar-foreground"
          onPointerDown={() => setOpen((cur) => (cur === "peek" ? "open" : cur))}
        >
          <div data-slot="overlay-inner" className="flex size-full flex-col bg-sidebar">
            {sidebar}
          </div>
        </div>
        {children}
      </div>
    </OverlayCtx.Provider>
  );
}

function useOverlay() {
  const ctx = useContext(OverlayCtx);
  if (!ctx) throw new Error("Overlay components need Overlay");
  return ctx;
}

export function OverlayTrigger() {
  const { toggle } = useOverlay();
  return (
    <Button
      data-testid="sidebar-trigger"
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon-sm"
      className="fixed top-(--overlay-trigger-top) left-(--overlay-trigger-left) z-20 size-4! overflow-hidden rounded-none border border-transparent p-0 hover:bg-transparent"
      onClick={toggle}
    >
      <PanelLeftIcon />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  );
}

export function OverlayPin() {
  const { pinned, togglePin } = useOverlay();
  return (
    <Button
      data-testid="sidebar-pin"
      variant="ghost"
      size="icon-xs"
      aria-pressed={pinned}
      title={pinned ? "Unpin sidebar" : "Pin sidebar"}
      onClick={togglePin}
    >
      {pinned ? <PinOffIcon /> : <PinIcon />}
      <span className="sr-only">{pinned ? "Unpin sidebar" : "Pin sidebar"}</span>
    </Button>
  );
}
