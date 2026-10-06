"use client";

import {
  ChevronsUpDownIcon,
  KeyboardIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DropdownMenu } from "radix-ui";
import { useOverlay } from "@/components/Overlay";
import { setTheme, type Theme, useTheme } from "@/lib/theme";

const THEME_OPTIONS = {
  light: [SunIcon, "Light"],
  dark: [MoonIcon, "Dark"],
  system: [MonitorIcon, "System"],
} as const;

export default function UserMenu({
  username,
  onShortcuts,
  onLogout,
}: {
  username: string;
  onShortcuts: () => void;
  onLogout: () => void;
}) {
  const theme = useTheme();
  const { expanded } = useOverlay();
  const [open, setOpen] = useState(false);
  if (open && !expanded) setOpen(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // Capture phase: the canvas and shortcuts handle their own events before they would bubble.
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const target = e.target as Node;
      if (!trigger.current?.contains(target) && !content.current?.contains(target)) setOpen(false);
    };
    const events = ["pointerdown", "wheel", "keydown"] as const;
    for (const type of events) document.addEventListener(type, close, true);
    return () => {
      for (const type of events) document.removeEventListener(type, close, true);
    };
  }, [open]);
  const avatar = (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground uppercase">
      {username.slice(0, 1)}
    </span>
  );
  return (
    // Not modal and not portalled: the sidebar overlay closes on any pointerdown outside it.
    <DropdownMenu.Root modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger
        ref={trigger}
        data-testid="user-menu"
        className="m-2 flex items-center gap-2 rounded-lg p-1.5 text-left outline-hidden hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[state=open]:bg-sidebar-accent"
      >
        {avatar}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{username}</span>
        <ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        ref={content}
        side="top"
        align="start"
        sideOffset={4}
        className="z-50 w-(--radix-dropdown-menu-trigger-width) rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
      >
        <div className="flex items-center gap-2 py-1 pr-1 pl-1">
          <DropdownMenu.Label className="flex min-w-0 flex-1 items-center gap-2">
            {avatar}
            <span className="min-w-0 truncate text-sm font-medium">{username}</span>
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            aria-label="Theme"
            value={theme}
            onValueChange={(t) => setTheme(t as Theme)}
            className="flex gap-0.5 rounded-md bg-muted p-0.5"
          >
            {(Object.keys(THEME_OPTIONS) as Theme[]).map((t) => {
              const [Icon, label] = THEME_OPTIONS[t];
              return (
                <DropdownMenu.RadioItem
                  key={t}
                  value={t}
                  data-testid={`theme-${t}`}
                  aria-label={`${label} theme`}
                  title={label}
                  onSelect={(e) => e.preventDefault()}
                  className="flex size-6 cursor-default items-center justify-center rounded-sm text-muted-foreground outline-hidden select-none focus:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=checked]:bg-background data-[state=checked]:text-foreground data-[state=checked]:shadow-sm"
                >
                  <Icon className="size-3.5" />
                </DropdownMenu.RadioItem>
              );
            })}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Item
            data-testid="shortcuts"
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
            className="flex size-7 shrink-0 cursor-default items-center justify-center rounded-md text-muted-foreground outline-hidden select-none hover:bg-muted hover:text-foreground focus:bg-muted focus:text-foreground"
            onSelect={onShortcuts}
          >
            <KeyboardIcon className="size-4" />
          </DropdownMenu.Item>
        </div>
        <DropdownMenu.Separator className="-mx-1 my-1 h-px bg-border" />
        <DropdownMenu.Item
          data-testid="logout"
          className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground"
          onSelect={onLogout}
        >
          <LogOutIcon className="size-4 text-muted-foreground" />
          Log out
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
