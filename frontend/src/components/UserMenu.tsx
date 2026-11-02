"use client";

import {
  BrushIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  CircleDotIcon,
  CopyIcon,
  HandIcon,
  KeyboardIcon,
  LayoutGridIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  PentagonIcon,
  ScanIcon,
  ShapesIcon,
  SunIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DropdownMenu, Slider } from "radix-ui";
import { useOverlay } from "@/components/Overlay";
import { SwitchTrack } from "@/components/ui/switch-track";
import { api, type Project } from "@/lib/api";
import { plural } from "@/lib/projects";
import type { Tool } from "@/lib/draw";
import { MIN_FILL_OPACITY, setFillOpacity, useFillOpacity } from "@/lib/fill-opacity";
import { setTheme, type Theme, useTheme } from "@/lib/theme";
import { setToolEnabled, TOOLS, useEnabledTools } from "@/lib/tools";

const THEME_OPTIONS = {
  light: [SunIcon, "Light"],
  dark: [MoonIcon, "Dark"],
  system: [MonitorIcon, "System"],
} as const;

const TOOL_ICONS: Record<Tool, typeof HandIcon> = {
  hand: HandIcon,
  point: CircleDotIcon,
  polygon: PentagonIcon,
  brush: BrushIcon,
  "ai-box": ScanIcon,
};

const ROW =
  "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground";

export default function UserMenu({
  username,
  project,
  onCopied,
  splitHisto,
  onSplitHisto,
  onShortcuts,
  onLogout,
}: {
  username: string;
  project: Project;
  onCopied: (project: Project) => void;
  splitHisto: boolean;
  onSplitHisto: (split: boolean) => void;
  onShortcuts: () => void;
  onLogout: () => void;
}) {
  const theme = useTheme();
  const enabledTools = useEnabledTools();
  const fillOpacity = useFillOpacity();
  const { expanded } = useOverlay();
  const [open, setOpen] = useState(false);
  if (open && !expanded) setOpen(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const toolsContent = useRef<HTMLDivElement>(null);
  // The outcome of the last copy, or why it failed.
  const [copied, setCopied] = useState<string | null>(null);
  // Capture phase: the canvas and shortcuts handle their own events before they would bubble.
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const target = e.target as Node;
      if (![trigger, content, toolsContent].some((ref) => ref.current?.contains(target)))
        setOpen(false);
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
        className="m-2 mr-0 flex min-w-0 flex-1 items-center gap-2 rounded-lg p-1.5 text-left outline-hidden hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[state=open]:bg-sidebar-accent"
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
        className="z-50 w-[calc(var(--radix-dropdown-menu-trigger-width)+2.5rem)] rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
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
        {project.shared_layer && (
          <DropdownMenu.Item
            data-testid="copy-to-layer"
            className={ROW}
            title="Adds your own annotations on this project's images that the shared layer lacks"
            onSelect={(e) => {
              e.preventDefault();
              void api.copyToLayer(project.id).then(
                ({ copied: n, project: next }) => {
                  setCopied(`Copied ${plural(n, "annotation")}`);
                  onCopied(next);
                },
                (error: Error) => setCopied(error.message),
              );
            }}
          >
            <CopyIcon className="size-4 text-muted-foreground" />
            {copied ?? "Copy my annotations to the shared layer"}
          </DropdownMenu.Item>
        )}
        {project.shared_layer && <DropdownMenu.Separator className="-mx-1 my-1 h-px bg-border" />}
        <div className="flex items-center gap-2 px-2 py-1.5 text-sm">
          <PentagonIcon
            fill="currentColor"
            fillOpacity={0.35}
            className="size-4 shrink-0 text-muted-foreground"
          />
          <span>Fill</span>
          <Slider.Root
            data-testid="fill-opacity"
            min={MIN_FILL_OPACITY}
            max={1}
            step={0.01}
            value={[fillOpacity]}
            onValueChange={([n]) => setFillOpacity(n)}
            className="relative ml-1 flex h-4 flex-1 touch-none items-center"
          >
            <Slider.Track className="relative h-1 grow rounded-full bg-muted">
              <Slider.Range className="absolute h-full rounded-full bg-primary" />
            </Slider.Track>
            <Slider.Thumb
              aria-label="Fill opacity"
              className="block size-3 rounded-full border border-ring bg-white outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            />
          </Slider.Root>
          <span className="w-8 text-right text-xs text-muted-foreground tabular-nums">
            {Math.round(fillOpacity * 100)}%
          </span>
        </div>
        <DropdownMenu.Sub>
          <DropdownMenu.SubTrigger
            data-testid="tools-menu"
            className={`${ROW} data-[state=open]:bg-accent data-[state=open]:text-accent-foreground`}
          >
            <ShapesIcon className="size-4 text-muted-foreground" />
            <span className="flex-1">Tools</span>
            <ChevronRightIcon className="size-4 text-muted-foreground" />
          </DropdownMenu.SubTrigger>
          <DropdownMenu.Portal>
            <DropdownMenu.SubContent
              ref={toolsContent}
              sideOffset={6}
              className="z-50 w-52 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
            >
              {TOOLS.map(([id, label, key]) => {
                const Icon = TOOL_ICONS[id];
                const on = enabledTools.includes(id);
                return (
                  <DropdownMenu.CheckboxItem
                    key={id}
                    data-testid={`tool-enabled-${id}`}
                    checked={on}
                    // The last enabled tool stays on so there is always something to draw with.
                    disabled={on && enabledTools.length === 1}
                    onCheckedChange={(checked) => setToolEnabled(id, checked)}
                    onSelect={(e) => e.preventDefault()}
                    className={`${ROW} data-disabled:opacity-60`}
                  >
                    <Icon className="size-4 text-muted-foreground" />
                    <span className="flex-1">{label}</span>
                    <kbd className="font-sans text-xs text-muted-foreground">{key}</kbd>
                    <SwitchTrack on={on} />
                  </DropdownMenu.CheckboxItem>
                );
              })}
            </DropdownMenu.SubContent>
          </DropdownMenu.Portal>
        </DropdownMenu.Sub>
        <DropdownMenu.CheckboxItem
          data-testid="split-histo"
          checked={splitHisto}
          onCheckedChange={onSplitHisto}
          onSelect={(e) => e.preventDefault()}
          className={ROW}
        >
          <LayoutGridIcon className="size-4 text-muted-foreground" />
          <span className="flex-1">Split histology by tissue</span>
          <SwitchTrack on={splitHisto} />
        </DropdownMenu.CheckboxItem>
        <DropdownMenu.Separator className="-mx-1 my-1 h-px bg-border" />
        <DropdownMenu.Item data-testid="logout" className={ROW} onSelect={onLogout}>
          <LogOutIcon className="size-4 text-muted-foreground" />
          Log out
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
