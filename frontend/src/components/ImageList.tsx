"use client";

import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "cn";
import { api, type ImageCatalog, type ImageRow, imageThumbnailUrl } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import MarkDot from "@/components/MarkDot";
import { type ImageGroup, isDone, rowMark } from "@/lib/images";

type Stain = string | null;
const stainLabel = (stain: Stain) => stain ?? "No stain";

const PREVIEW_DELAY_MS = 250;
const PREVIEW_MARGIN = 8;
type Preview = { row: ImageRow; left: number; mid: number };

function Thumbnail({
  id,
  onEnter,
  onLeave,
}: {
  id: string;
  onEnter: (thumb: HTMLElement) => void;
  onLeave: () => void;
}) {
  // A removed thumbnail never gets pointerleave, so hide its preview on unmount.
  useEffect(() => onLeave, [onLeave]);
  return (
    // eslint-disable-next-line @next/next/no-img-element -- served by the API, not Next's optimizer
    <img
      src={imageThumbnailUrl(id, 80)}
      onPointerEnter={(e) => onEnter(e.currentTarget)}
      onPointerLeave={onLeave}
      alt=""
      width={40}
      height={24}
      loading="lazy"
      decoding="async"
      draggable={false}
      className="h-6 w-10 shrink-0 rounded-sm bg-muted object-contain"
      onError={(e) => (e.currentTarget.style.visibility = "hidden")}
    />
  );
}

// Portaled with fixed positioning so the sidebar's overflow and clip-path don't cut it off.
function ThumbnailPreview({ preview }: { preview: Preview }) {
  const root = useRef<HTMLDivElement>(null);
  const [image, setImage] = useState<"loading" | "loaded" | "failed">("loading");
  useLayoutEffect(() => {
    const card = root.current!;
    const max = window.innerHeight - card.offsetHeight - PREVIEW_MARGIN;
    const top = Math.min(preview.mid - card.offsetHeight / 2, max);
    card.style.top = `${Math.max(PREVIEW_MARGIN, top)}px`;
    const right = window.innerWidth - card.offsetWidth - PREVIEW_MARGIN;
    card.style.left = `${Math.max(PREVIEW_MARGIN, Math.min(preview.left, right))}px`;
  }, [preview.left, preview.mid, image]);
  return createPortal(
    <div
      ref={root}
      data-testid="image-preview"
      className="pointer-events-none fixed z-50 w-67 rounded-lg bg-popover p-1.5 text-popover-foreground shadow-md ring-1 ring-foreground/10"
    >
      {image !== "failed" && (
        // eslint-disable-next-line @next/next/no-img-element -- served by the API, not Next's optimizer
        <img
          src={imageThumbnailUrl(preview.row.id, 512)}
          alt=""
          decoding="async"
          className={cn(
            "mx-auto mb-1 max-h-64 max-w-64 rounded-sm object-contain",
            image === "loading" && "h-48 w-64 bg-muted",
          )}
          onLoad={() => setImage("loaded")}
          onError={() => setImage("failed")}
        />
      )}
      <p className="text-xs break-words">{preview.row.name}</p>
    </div>,
    document.body,
  );
}

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

function useDismiss(root: RefObject<HTMLElement | null>, onClose: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const outside = (e: Event) => {
      if (!root.current?.contains(e.target as Node)) onClose();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Wheel too: an unpinned sidebar collapses on outside wheel and would reopen with the menu up.
    document.addEventListener("pointerdown", outside);
    document.addEventListener("wheel", outside, { passive: true });
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("wheel", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [root, onClose, enabled]);
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
  useDismiss(
    root,
    useCallback(() => setOpen(false), []),
    open,
  );

  if (!catalog?.stains.some((s) => s.name !== null)) return null;
  const toggle = (stain: Stain) =>
    onStains(stains.includes(stain) ? stains.filter((s) => s !== stain) : [...stains, stain]);

  return (
    <div ref={root} className="relative py-1">
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
          className="absolute inset-x-0 top-full z-30 max-h-64 overflow-auto [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin] rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
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

const MENU_WIDTH = 144;
type RowMenu = { row: ImageRow; x: number; y: number };

// Positioned inside the list, not portaled, so it stays within an unpinned sidebar overlay.
// Fetches the path on open so the copy click stays synchronous and keeps clipboard permission.
function ImageRowMenu({ menu, onClose }: { menu: RowMenu; onClose: () => void }) {
  // null while loading, false if it could not be loaded.
  const [path, setPath] = useState<string | null | false>(null);
  const root = useRef<HTMLDivElement>(null);
  const [above, setAbove] = useState(false);
  useDismiss(root, onClose);
  useLayoutEffect(() => {
    // Flip above the cursor near the bottom, where the sidebar scroller would clip it.
    let scroller = root.current!.parentElement;
    while (scroller && getComputedStyle(scroller).overflowY === "visible")
      scroller = scroller.parentElement;
    const bottom = scroller?.getBoundingClientRect().bottom ?? window.innerHeight;
    setAbove(root.current!.getBoundingClientRect().bottom > bottom);
  }, []);
  useEffect(() => {
    let live = true;
    api.imagePath(menu.row.id).then(
      (r) => live && setPath(r.path),
      () => live && setPath(false),
    );
    return () => {
      live = false;
    };
  }, [menu.row.id]);

  const copy = (text: string) => {
    copyText(text);
    onClose();
  };
  const item =
    "w-full rounded-md px-2 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:text-muted-foreground";
  return (
    <div
      ref={root}
      role="menu"
      data-testid="image-row-menu"
      style={{ left: menu.x, top: menu.y, width: MENU_WIDTH }}
      className={cn(
        "absolute z-50 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10",
        above && "-translate-y-full",
      )}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button type="button" role="menuitem" className={item} onClick={() => copy(menu.row.name)}>
        Copy name
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={!path}
        title={path || undefined}
        className={item}
        onClick={() => path && copy(path)}
      >
        {path === false ? "Path unavailable" : "Copy path"}
      </button>
    </div>
  );
}

export default function ImageList({
  groups,
  failed,
  currentId,
  onOpen,
}: {
  groups: ImageGroup[] | null;
  failed: boolean;
  currentId: string | null;
  onOpen: (itemId: string) => void;
}) {
  const currentGroup = groups?.find((g) => g.rows.some((r) => r.id === currentId))?.name ?? null;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [revealed, setRevealed] = useState<string | null>(null);
  if (currentGroup !== revealed) {
    setRevealed(currentGroup);
    if (currentGroup !== null) setExpanded((open) => new Set(open).add(currentGroup));
  }
  const currentRow = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [preview, setPreview] = useState<Preview | null>(null);
  const previewTimer = useRef(0);
  const hidePreview = useCallback(() => {
    window.clearTimeout(previewTimer.current);
    setPreview(null);
  }, []);
  useEffect(() => {
    // Capture catches the sidebar scroller, whose scroll events don't bubble.
    document.addEventListener("scroll", hidePreview, true);
    return () => {
      document.removeEventListener("scroll", hidePreview, true);
      window.clearTimeout(previewTimer.current);
    };
  }, [hidePreview]);
  const currentOpen = currentGroup !== null && expanded.has(currentGroup);
  const loaded = groups !== null;
  // Not on every regroup: edits and saves would pull the list back to the current image.
  useEffect(() => {
    currentRow.current?.scrollIntoView({ block: "nearest" });
  }, [currentId, loaded, currentOpen]);

  if (!groups)
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
    <div ref={list} data-testid="image-list" className="relative flex flex-col gap-0.5">
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
              data-scroll-mark={(!open && group.mark) || undefined}
              className="flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent"
              onClick={() => toggle(group.name)}
            >
              <Chevron className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{group.name || "Ungrouped"}</span>
              <MarkDot mark={group.mark} />
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
                    data-scroll-mark={rowMark(row) ?? undefined}
                    className={cn(
                      "relative flex items-center gap-2 rounded-md py-1 pr-2 pl-8 text-left text-sm hover:bg-sidebar-accent",
                      current && "bg-sidebar-accent font-medium",
                    )}
                    onClick={() => !current && onOpen(row.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      hidePreview();
                      const box = list.current!.getBoundingClientRect();
                      setMenu({
                        row,
                        x: Math.min(e.clientX - box.left, box.width - MENU_WIDTH),
                        y: e.clientY - box.top,
                      });
                    }}
                  >
                    {current && (
                      <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-sidebar-primary" />
                    )}
                    <Thumbnail
                      id={row.id}
                      onEnter={(thumb) => {
                        if (menu) return;
                        window.clearTimeout(previewTimer.current);
                        previewTimer.current = window.setTimeout(() => {
                          const box = thumb.getBoundingClientRect();
                          const panel = thumb.closest("[data-slot=overlay-panel]") ?? thumb;
                          setPreview({
                            row,
                            left: panel.getBoundingClientRect().right + PREVIEW_MARGIN,
                            mid: (box.top + box.bottom) / 2,
                          });
                        }, PREVIEW_DELAY_MS);
                      }}
                      onLeave={hidePreview}
                    />
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
      {menu && <ImageRowMenu key={menu.row.id} menu={menu} onClose={closeMenu} />}
      {preview && <ThumbnailPreview key={preview.row.id} preview={preview} />}
    </div>
  );
}
