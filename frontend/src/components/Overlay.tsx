"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { PanelLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

const OverlayCtx = createContext<{ toggle: () => void } | null>(null);

export function Overlay({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      const el = e.target as Element | null;
      if (el?.closest("[data-slot=overlay-panel],[data-slot=sidebar-trigger]")) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("wheel", outside, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("wheel", outside);
    };
  }, [open]);
  return (
    <OverlayCtx.Provider value={{ toggle: () => setOpen((o) => !o) }}>
      <div
        data-slot="overlay"
        data-state={open ? "expanded" : "collapsed"}
        className="flex h-dvh min-h-0 w-full"
      >
        <div
          data-slot="overlay-panel"
          className="fixed inset-y-0 left-0 z-20 flex h-svh w-(--overlay-width) text-sidebar-foreground"
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

export function OverlayTrigger() {
  const ctx = useContext(OverlayCtx);
  if (!ctx) throw new Error("OverlayTrigger needs Overlay");
  return (
    <Button
      data-testid="sidebar-trigger"
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon-sm"
      className="fixed top-(--overlay-trigger-top) left-(--overlay-trigger-left) z-20 size-4! overflow-hidden rounded-none border border-transparent p-0 hover:bg-transparent"
      onClick={ctx.toggle}
    >
      <PanelLeftIcon />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  );
}
