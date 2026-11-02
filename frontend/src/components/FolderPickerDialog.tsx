"use client";

import { useEffect, useState } from "react";
import { CheckIcon, ChevronRightIcon, CornerLeftUpIcon } from "lucide-react";
import { cn } from "cn";
import { Button, PILL } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api, type FolderLevel } from "@/lib/api";
import { plural } from "@/lib/projects";

function Box({ on, muted }: { on: boolean; muted?: boolean }) {
  return (
    <span
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[5px] border-[1.5px] border-muted-foreground",
        on && "border-foreground bg-foreground text-background",
        on && muted && "border-muted-foreground bg-muted-foreground",
      )}
    >
      {on && <CheckIcon className="size-3" strokeWidth={3} />}
    </span>
  );
}

// Multi-select over the whole image server; the project normalizes nested picks on save.
export default function FolderPickerDialog({
  open,
  onOpenChange,
  existing,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing: string[];
  onAdd: (ids: string[]) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="folder-picker-dialog">
        {/* Inside the content, so each opening starts fresh at the top. */}
        <Picker existing={existing} onAdd={onAdd} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function Picker({
  existing,
  onAdd,
  onClose,
}: {
  existing: string[];
  onAdd: (ids: string[]) => void;
  onClose: () => void;
}) {
  // Every level from the top down to the one shown, for the breadcrumbs.
  const [stack, setStack] = useState<FolderLevel[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    api.folders(null).then(
      (root) => live && setStack([root]),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, []);

  async function go(id: string, depth: number) {
    setLoading(true);
    try {
      const next = await api.folders(id);
      setStack((s) => [...s.slice(0, depth), next]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load this folder.");
    } finally {
      setLoading(false);
    }
  }

  const level = stack.at(-1);
  const chosen = new Set([...existing, ...picked]);
  // Inside a chosen folder everything is already included.
  const covered = stack.some((l) => l.id && chosen.has(l.id));
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <>
      <DialogTitle>Add folders</DialogTitle>
      <nav
        aria-label="Folder path"
        className="-mt-2 flex flex-wrap items-center gap-0.5 text-sm text-muted-foreground"
      >
        {stack.map((l, i) => {
          const label = l.id ? l.name : "Datasets";
          return i === stack.length - 1 ? (
            <strong key={l.id ?? "root"} className="px-1.5 font-medium text-foreground">
              {label}
            </strong>
          ) : (
            <span key={l.id ?? "root"} className="flex items-center gap-0.5">
              <button
                type="button"
                className="rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
                onClick={() => setStack((s) => s.slice(0, i + 1))}
              >
                {label}
              </button>
              <ChevronRightIcon className="size-3.5" />
            </span>
          );
        })}
      </nav>
      <div
        className={cn(
          "max-h-80 overflow-y-auto rounded-xl border",
          loading && "pointer-events-none opacity-60",
        )}
      >
        {!level && <p className="px-4 py-3 text-muted-foreground">{error ?? "Loading folders"}</p>}
        {level?.id && (
          <button
            type="button"
            data-testid="pick-parent"
            disabled={covered && !picked.includes(level.id)}
            className="grid w-full grid-cols-[1rem_1fr_auto] items-center gap-3 border-b px-4 py-2.5 text-left hover:bg-muted/60 disabled:text-muted-foreground"
            onClick={() => toggle(level.id!)}
          >
            {chosen.has(level.id) ? (
              <Box on muted={existing.includes(level.id)} />
            ) : (
              <CornerLeftUpIcon className="size-4 text-muted-foreground" />
            )}
            <span className="truncate">Use “{level.name}” instead</span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {level.children.length > 0 && `${plural(level.children.length, "folder")} · `}
              {plural(level.n_items, "image")}
            </span>
          </button>
        )}
        {level?.children.map((child) => {
          const already = existing.includes(child.id) || (covered && !picked.includes(child.id));
          const on = already || picked.includes(child.id);
          return (
            <div
              key={child.id}
              className={cn(
                "grid grid-cols-[1fr_auto] items-center border-b last:border-b-0 hover:bg-muted/60",
                already && "text-muted-foreground",
              )}
            >
              <button
                type="button"
                data-testid={`pick-folder-${child.id}`}
                disabled={already}
                className="grid min-w-0 grid-cols-[1rem_1fr_auto] items-center gap-3 py-2.5 pl-4 text-left"
                onClick={() => toggle(child.id)}
              >
                <Box on={on} muted={already} />
                <span className="truncate">{child.name}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {already ? "Already added" : plural(child.n_items, "image")}
                </span>
              </button>
              {child.n_folders > 0 ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Open ${child.name}`}
                  data-testid={`open-folder-${child.id}`}
                  className="mx-2 rounded-full text-muted-foreground"
                  onClick={() => void go(child.id, stack.length)}
                >
                  <ChevronRightIcon />
                </Button>
              ) : (
                <span className="w-11" />
              )}
            </div>
          );
        })}
      </div>
      {error && level && (
        <p role="alert" className="-mt-2 text-destructive">
          {error}
        </p>
      )}
      <DialogDescription>
        Choosing a parent folder replaces the subfolders you already added. Annotations stay where
        they are.
      </DialogDescription>
      <div className="flex justify-end gap-2">
        <Button variant="outline" className={PILL} onClick={onClose}>
          Cancel
        </Button>
        <Button
          className={PILL}
          data-testid="add-folders"
          disabled={!picked.length}
          onClick={() => {
            onAdd(picked);
            onClose();
          }}
        >
          {picked.length > 1 ? `Add ${picked.length} folders` : "Add folder"}
        </Button>
      </div>
    </>
  );
}
