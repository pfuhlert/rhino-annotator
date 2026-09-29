"use client";

import { useEffect, useState } from "react";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, FolderIcon } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { api, type FolderChild, type FolderLevel } from "@/lib/api";

function FolderRow({
  child,
  active,
  onOpen,
  onUse,
}: {
  child: FolderChild;
  active: boolean;
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
      <button
        type="button"
        data-testid={`folder-${child.id}`}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
        onClick={drill ? onOpen : onUse}
      >
        <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className={cn("min-w-0 flex-1 truncate", active && "font-medium")}>{child.name}</span>
        {child.n_items > 0 && (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {child.n_items}
          </span>
        )}
        {active && <CheckIcon className="size-3.5 shrink-0" />}
        {drill && <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />}
      </button>
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

export default function FolderPicker({
  selectedId,
  initialLevel,
  onUse,
}: {
  selectedId: string | null;
  initialLevel: FolderLevel | null;
  onUse: (id: string) => void;
}) {
  const [level, setLevel] = useState(initialLevel);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (level) return;
    let live = true;
    api
      .folders(null)
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
    void api.folders(id).then(
      (next) => {
        setError(null);
        setLevel(next);
      },
      (e: Error) => setError(e.message),
    );
  const levelId = level.id;

  return (
    <div data-testid="folder-switcher" className="flex flex-col gap-0.5">
      <div className="flex h-8 items-center gap-1 px-1 text-xs font-medium text-sidebar-foreground/70">
        {level.id && (
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
        {levelId &&
          (levelId === selectedId ? (
            <CheckIcon className="mr-1 size-3.5 shrink-0" />
          ) : (
            <UseButton testId="use-current-folder" onClick={() => onUse(levelId)} />
          ))}
      </div>
      {error && (
        <p role="alert" className="px-2 py-1 text-xs text-destructive">
          Could not load this folder. {error}
        </p>
      )}
      {level.children.length === 0 && (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          {level.n_items} image{level.n_items === 1 ? "" : "s"}, no subfolders with images.
        </p>
      )}
      {level.children.map((child) => (
        <FolderRow
          key={child.id}
          child={child}
          active={child.id === selectedId}
          onOpen={() => go(child.id)}
          onUse={() => onUse(child.id)}
        />
      ))}
    </div>
  );
}
