"use client";

import {
  createContext,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { PanelLeftIcon, PinIcon } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";

const PIN_KEY = "sidebar-pinned";
const WIDTH_KEY = "sidebar-width";
const WIDTH = { min: 224, default: 256, max: 480 };
const EDGE_PX = 8;
const PEEK_CLOSE_MS = 300;

type OverlayState = {
  toggle: () => void;
  expanded: boolean;
  pinned: boolean;
  togglePin: () => void;
};
const OverlayCtx = createContext<OverlayState | null>(null);

function readPinned() {
  try {
    return localStorage.getItem(PIN_KEY) === "1";
  } catch {
    return false;
  }
}

function readWidth() {
  try {
    const width = Number(localStorage.getItem(WIDTH_KEY));
    return width ? clampWidth(width) : WIDTH.default;
  } catch {
    return WIDTH.default;
  }
}

const clampWidth = (px: number) => Math.round(Math.min(WIDTH.max, Math.max(WIDTH.min, px)));

function ResizeHandle({ onResize }: { onResize: (px: number) => void }) {
  const [dragging, setDragging] = useState(false);
  function start(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      data-testid="sidebar-resize"
      title="Drag to resize, double-click to reset"
      className={cn(
        "group absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize touch-none",
        dragging && "active",
      )}
      onPointerDown={start}
      onPointerMove={(e) => dragging && onResize(clampWidth(e.clientX))}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onDoubleClick={() => onResize(WIDTH.default)}
    >
      <span className="absolute inset-y-0 right-0 w-px bg-sidebar-border transition-colors group-hover:w-0.5 group-hover:bg-sidebar-ring group-[.active]:w-0.5 group-[.active]:bg-sidebar-ring" />
    </div>
  );
}

export function Overlay({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState<"closed" | "peek" | "open">("open");
  const [pinned, setPinned] = useState(readPinned);
  const [width, setWidth] = useState(readWidth);
  const panelRef = useRef<HTMLDivElement>(null);
  const expanded = pinned || open !== "closed";

  useEffect(() => {
    if (!expanded || pinned) return;
    const outside = (e: Event) => {
      const el = e.target as Element | null;
      // An open dialog and its backdrop sit outside the panel but don't dismiss it.
      if (document.querySelector("[role=dialog]")) return;
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

  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {}
  }, [width]);

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
    expanded,
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
        style={{ "--overlay-width": `${width}px` } as CSSProperties}
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
          <ResizeHandle onResize={setWidth} />
        </div>
        {children}
      </div>
    </OverlayCtx.Provider>
  );
}

export function useOverlay() {
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
      className={cn("text-muted-foreground hover:text-foreground", pinned && "text-foreground")}
      onClick={togglePin}
    >
      <PinIcon
        className={cn("size-3.5! transition-transform", pinned ? "fill-current" : "rotate-45")}
      />
      <span className="sr-only">{pinned ? "Unpin sidebar" : "Pin sidebar"}</span>
    </Button>
  );
}
