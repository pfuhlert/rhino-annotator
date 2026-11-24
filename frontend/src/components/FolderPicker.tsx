"use client";

import { type ReactNode, useEffect, useState } from "react";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  RefreshCwIcon,
} from "lucide-react";
import { cn } from "cn";
import MarkDot from "@/components/MarkDot";
import { Button } from "@/components/ui/button";
import { api, type FolderChild, type FolderLevel } from "@/lib/api";
import type { Mark } from "@/lib/images";

function CollapseToggle({
  collapsed,
  onToggle,
  className,
}: {
  collapsed: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const Icon = collapsed ? FolderIcon : FolderOpenIcon;
  return (
    <Button
      data-testid="folder-collapse"
      variant="ghost"
      size="icon-xs"
      aria-expanded={!collapsed}
      aria-label={collapsed ? "Show images" : "Hide images"}
      className={cn("text-muted-foreground hover:text-foreground", className)}
      onClick={onToggle}
    >
      <Icon className="size-4" />
    </Button>
  );
}

function RefreshButton({ indexing, onRefresh }: { indexing: boolean; onRefresh: () => void }) {
  return (
    <Button
      data-testid="folder-refresh"
      variant="ghost"
      size="icon-xs"
      disabled={indexing}
      aria-label="Refresh images"
      title={indexing ? "Indexing folder…" : "List this folder's images again"}
      className="text-muted-foreground hover:text-foreground"
      onClick={onRefresh}
    >
      <RefreshCwIcon className={cn("size-3.5", indexing && "animate-spin")} />
    </Button>
  );
}

function FolderRow({
  child,
  active,
  mark,
  collapsed,
  refresh,
  onToggle,
  onOpen,
  onUse,
}: {
  child: FolderChild;
  active: boolean;
  mark: Mark | null;
  collapsed: boolean;
  refresh: ReactNode;
  onToggle: () => void;
  onOpen: () => void;
  onUse: () => void;
}) {
  const drill = child.n_folders > 0;
  return (
    <div
      className={cn(
        "group relative flex items-center rounded-md hover:bg-sidebar-accent",
        active && "bg-sidebar-accent",
      )}
    >
      {active && (
        <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-sidebar-primary" />
      )}
      {/* Takes the folder icon's place, so the name stays aligned with the other rows. */}
      {active && <CollapseToggle collapsed={collapsed} onToggle={onToggle} className="ml-1" />}
      <button
        type="button"
        data-testid={`folder-${child.id}`}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-2 text-left text-sm",
          active ? "pl-1" : "pl-2",
        )}
        onClick={drill ? onOpen : active ? onToggle : onUse}
      >
        {!active && <FolderIcon className="size-4 shrink-0 text-muted-foreground" />}
        <span className={cn("min-w-0 flex-1 truncate", active && "font-medium")}>{child.name}</span>
        <MarkDot mark={mark} />
        {child.n_items > 0 && (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {child.n_items}
          </span>
        )}
        {active && <CheckIcon className="size-3.5 shrink-0" />}
        {drill && <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />}
      </button>
      {active && <span className="mr-1">{refresh}</span>}
      {drill && !active && (
        <UseButton
          testId={`use-folder-${child.id}`}
          className="mr-1 hidden group-focus-within:inline-flex group-hover:inline-flex"
          onClick={onUse}
        />
      )}
    </div>
  );
}

function UseButton({
  testId,
  className,
  onClick,
}: {
  testId: string;
  className?: string;
  onClick: () => void;
}) {
  return (
    <Button
      data-testid={testId}
      type="button"
      size="xs"
      variant="outline"
      title="Use all images in this folder and its subfolders"
      className={className}
      onClick={onClick}
    >
      Use
    </Button>
  );
}

type Progress = { done: number; total: number };

// The label is drawn twice, the filled copy clipped to the fill, so it reads on both halves.
function ProgressBar({ done, total }: Progress) {
  const label = `${done}/${total} done`;
  return (
    <div
      role="progressbar"
      aria-label="Images done"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      data-testid="folder-progress"
      className="relative mt-1 h-3.5 overflow-hidden rounded-full bg-sidebar-accent text-center text-[10px] leading-3.5 font-medium tabular-nums"
    >
      <span className="text-sidebar-foreground/70">{label}</span>
      <span
        aria-hidden
        className="absolute inset-0 bg-sidebar-primary text-sidebar-primary-foreground transition-[clip-path]"
        style={{ clipPath: `inset(0 ${100 - (done / total) * 100}% 0 0)` }}
      >
        {label}
      </span>
    </div>
  );
}

// The selected folder and its pinned controls stay in view, opaque, while its images scroll by.
function Pinned({
  pinned,
  progress,
  className,
  children,
}: {
  pinned: ReactNode;
  progress: Progress | null;
  className: string;
  children: ReactNode;
}) {
  return (
    <div data-scroll-pin className={cn("sticky z-10 flex flex-col bg-sidebar", className)}>
      {children}
      {progress && progress.total > 0 && <ProgressBar {...progress} />}
      <div className="pt-0.5 empty:hidden">{pinned}</div>
    </div>
  );
}

export default function FolderPicker({
  selectedId,
  initialLevel,
  onUse,
  indexing,
  onRefresh,
  pinned,
  progress,
  mark,
  selected,
}: {
  selectedId: string | null;
  initialLevel: FolderLevel | null;
  onUse: (id: string) => void;
  // The selected folder's images are being listed again.
  indexing: boolean;
  onRefresh: () => void;
  // Shown under the selected folder, which may be this level itself or one of its rows.
  pinned: ReactNode;
  // Over the selected folder's listed images, null while they load.
  progress: Progress | null;
  // Strongest mark among the selected folder's listed images.
  mark: Mark | null;
  selected: ReactNode;
}) {
  const [level, setLevel] = useState(initialLevel);
  const [error, setError] = useState<string | null>(null);
  // Keyed by folder, so switching to another folder shows its images again.
  const [collapsedId, setCollapsedId] = useState<string | null>(null);
  const collapsed = !!selectedId && collapsedId === selectedId;
  const toggle = () => setCollapsedId(collapsed ? null : selectedId);

  useEffect(() => {
    if (level) return;
    let live = true;
    api
      .folders(null, true)
      .then((root) => live && setLevel(root))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [level]);

  if (!level)
    return (
      <p className="px-2 text-xs text-muted-foreground">
        {error ? `Could not load folders. ${error}` : "Loading folders"}
      </p>
    );

  const go = (id: string | null) =>
    void api.folders(id, true).then(
      (next) => {
        setError(null);
        setLevel(next);
      },
      (e: Error) => setError(e.message),
    );
  const refresh = <RefreshButton indexing={indexing} onRefresh={onRefresh} />;
  const levelId = level.id;
  const levelSelected = !!levelId && levelId === selectedId;
  // A selected level already lists its subfolders as image groups; collapse it to browse them.
  const rows = levelSelected && !collapsed ? [] : level.children;
  const levelHeader = (
    // Row spacing is an opaque bottom border, not a flex gap, so pinned rows keep it when stuck.
    <div className="sticky top-0 z-20 flex h-8.5 items-center gap-1 border-b-2 border-sidebar bg-sidebar px-1 text-xs font-medium text-sidebar-foreground/70">
      {level.id && !level.root && (
        <Button
          data-testid="folder-back"
          variant="ghost"
          size="icon-xs"
          aria-label="Back"
          onClick={() => go(level.parent_id)}
        >
          <ChevronLeftIcon />
        </Button>
      )}
      <span className={cn("min-w-0 flex-1 truncate", !level.id && "px-1")}>
        {level.id ? level.name : "Datasets"}
      </span>
      {levelSelected && <MarkDot mark={mark} />}
      {levelSelected && refresh}
      {levelSelected && <CollapseToggle collapsed={collapsed} onToggle={toggle} />}
      {levelId &&
        (levelSelected ? (
          <CheckIcon className="mr-1 size-3.5 shrink-0" />
        ) : (
          <UseButton testId="use-current-folder" onClick={() => onUse(levelId)} />
        ))}
    </div>
  );

  return (
    <div data-testid="folder-switcher" className="flex flex-col">
      {levelSelected ? (
        <Pinned pinned={!collapsed && pinned} progress={progress} className="top-0">
          {levelHeader}
        </Pinned>
      ) : (
        levelHeader
      )}
      {error && (
        <p role="alert" className="px-2 py-1 text-xs text-destructive">
          Could not load this folder. {error}
        </p>
      )}
      {levelSelected
        ? !collapsed && <div className="mb-1">{selected}</div>
        : level.children.length === 0 && (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              {level.n_items} image{level.n_items === 1 ? "" : "s"}, no subfolders with images.
            </p>
          )}
      {rows.map((child) => {
        const row = (
          <FolderRow
            child={child}
            active={child.id === selectedId}
            mark={child.id === selectedId ? mark : null}
            collapsed={collapsed}
            refresh={refresh}
            onToggle={toggle}
            onOpen={() => go(child.id)}
            onUse={() => onUse(child.id)}
          />
        );
        return child.id === selectedId ? (
          <div key={child.id} className="flex flex-col">
            {/* Below the pinned level header (h-8.5). */}
            <Pinned pinned={!collapsed && pinned} progress={progress} className="top-8.5">
              {row}
            </Pinned>
            {!collapsed && <div className="mb-1">{selected}</div>}
          </div>
        ) : (
          <div key={child.id} className="pb-0.5">
            {row}
          </div>
        );
      })}
    </div>
  );
}
