"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "cn";
import type { ImageCatalog, ImageRow, Patch } from "@/lib/api";
import { groupImages, isDone } from "@/lib/images";

type Stain = string | null;
const stainLabel = (stain: Stain) => stain ?? "No stain";

function Progress({ row }: { row: ImageRow }) {
  if (row.regions === null) return null;
  if (row.regions === 1)
    return row.visited ? <CheckIcon className="size-3.5 text-muted-foreground" /> : null;
  return (
    <span className={cn("tabular-nums", !isDone(row) && "text-muted-foreground")}>
      {row.visited}/{row.regions}
    </span>
  );
}

// Renders inside the sidebar instead of a portal: the overlay closes on any outside pointerdown.
export function StainFilter({
  catalog,
  stains,
  onStains,
}: {
  catalog: ImageCatalog | null;
  stains: Stain[];
  onStains: (next: Stain[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  if (!catalog?.stains.some((s) => s.name !== null)) return null;
  const toggle = (stain: Stain) =>
    onStains(stains.includes(stain) ? stains.filter((s) => s !== stain) : [...stains, stain]);

  return (
    <div ref={root} className="relative px-1 py-1">
      <button
        type="button"
        data-testid="stain-filter"
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-7 w-full items-center gap-1.5 rounded-lg border border-input px-2 text-xs transition-colors hover:bg-sidebar-accent dark:bg-input/30"
        onClick={() => setOpen((o) => !o)}
      >
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-left",
            !stains.length && "text-muted-foreground",
          )}
        >
          {stains.length ? stains.map(stainLabel).join(", ") : "All stains"}
        </span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div
          role="listbox"
          aria-multiselectable
          className="absolute inset-x-1 top-full z-30 max-h-64 overflow-auto [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin] rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
        >
          {catalog.stains.map((s) => {
            const on = stains.includes(s.name);
            return (
              <button
                key={stainLabel(s.name)}
                type="button"
                role="option"
                aria-selected={on}
                data-testid={`stain-option-${stainLabel(s.name)}`}
                className="flex w-full items-center gap-1.5 rounded-md py-1 pr-1 pl-2 text-sm hover:bg-accent hover:text-accent-foreground"
                onClick={() => toggle(s.name)}
              >
                <span className="min-w-0 flex-1 truncate text-left">{stainLabel(s.name)}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{s.count}</span>
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {on && <CheckIcon className="size-3.5" />}
                </span>
              </button>
            );
          })}
          {stains.length > 0 && (
            <button
              type="button"
              data-testid="stain-clear"
              className="mt-1 w-full rounded-md border-t border-border px-1.5 pt-1.5 pb-1 text-left text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onStains([])}
            >
              Show all stains
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function ImageList({
  catalog,
  failed,
  patch,
  stains,
  onOpen,
}: {
  catalog: ImageCatalog | null;
  failed: boolean;
  patch: Patch | null;
  stains: Stain[];
  onOpen: (itemId: string) => void;
}) {
  const groups = useMemo(
    () => (catalog ? groupImages(catalog.items, stains, patch) : []),
    [catalog, stains, patch],
  );
  const currentId = patch?.item_id ?? null;
  const currentGroup = groups.find((g) => g.rows.some((r) => r.id === currentId))?.name ?? null;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [revealed, setRevealed] = useState<string | null>(null);
  if (currentGroup !== revealed) {
    setRevealed(currentGroup);
    if (currentGroup !== null) setExpanded((open) => new Set(open).add(currentGroup));
  }
  const currentRow = useRef<HTMLButtonElement>(null);
  const currentOpen = currentGroup !== null && expanded.has(currentGroup);
  useEffect(() => {
    currentRow.current?.scrollIntoView({ block: "nearest" });
  }, [currentId, catalog, currentOpen]);

  if (!catalog)
    return (
      <p className="px-2 text-xs text-muted-foreground">
        {failed ? "Could not load images." : "Loading images"}
      </p>
    );

  const toggle = (name: string) =>
    setExpanded((open) => {
      const next = new Set(open);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  return (
    <div data-testid="image-list" className="flex flex-col gap-0.5">
      {groups.length === 0 && (
        <p className="px-2 py-1 text-xs text-muted-foreground">No images match this filter.</p>
      )}
      {groups.map((group) => {
        const open = expanded.has(group.name);
        const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
        return (
          <div key={group.name} className="flex flex-col gap-0.5">
            <button
              type="button"
              data-testid={`image-group-${group.name}`}
              aria-expanded={open}
              className="flex items-center gap-1 rounded-md px-1 py-1 text-left text-xs font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent"
              onClick={() => toggle(group.name)}
            >
              <Chevron className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{group.name || "Ungrouped"}</span>
              <span className="shrink-0 tabular-nums">
                {group.done}/{group.rows.length}
              </span>
            </button>
            {open &&
              group.rows.map((row) => {
                const current = row.id === currentId;
                return (
                  <button
                    key={row.id}
                    ref={current ? currentRow : undefined}
                    type="button"
                    data-testid={`image-row-${row.id}`}
                    aria-current={current || undefined}
                    className={cn(
                      "relative flex items-center gap-2 rounded-md py-1 pr-2 pl-6 text-left text-sm hover:bg-sidebar-accent",
                      current && "bg-sidebar-accent font-medium",
                    )}
                    onClick={() => !current && onOpen(row.id)}
                  >
                    {current && (
                      <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-sidebar-primary" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{row.name}</span>
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                      {row.staining && <span className="max-w-16 truncate">{row.staining}</span>}
                      {row.magnification && <span>{row.magnification}×</span>}
                      <Progress row={row} />
                    </span>
                  </button>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}
