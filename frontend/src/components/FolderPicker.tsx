"use client";

import { useEffect, useState } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { api, type FolderChild, type FolderLevel } from "@/lib/api";

function FolderRow({
  id,
  name,
  nItems,
  active,
  onOpen,
  onUse,
}: {
  id: string;
  name: string;
  nItems: number;
  active: boolean;
  onOpen: () => void;
  onUse?: () => void;
}) {
  return (
    <div className={cn("flex items-center gap-1 rounded-md", active && "bg-sidebar-accent")}>
      <button
        type="button"
        data-testid={`folder-${id}`}
        className={cn(
          "min-w-0 flex-1 truncate rounded-md px-2 py-1 text-left text-sm hover:bg-sidebar-accent",
          active && "font-medium",
        )}
        onClick={onOpen}
      >
        {name}
        {nItems > 0 ? <span className="ml-1 text-xs text-muted-foreground">{nItems}</span> : null}
      </button>
      {onUse && (
        <Button type="button" size="xs" variant={active ? "default" : "outline"} onClick={onUse}>
          {active ? "Used" : "Use"}
        </Button>
      )}
    </div>
  );
}

async function chainTo(selectedId: string | null): Promise<FolderLevel[]> {
  const root = await api.folders(null);
  if (!selectedId) return [root];
  const here = await api.folders(selectedId);
  const upward: FolderLevel[] = here.id && here.children.length ? [here] : [];
  let pid = here.parent_id;
  while (pid) {
    const parent = await api.folders(pid);
    upward.unshift(parent);
    pid = parent.parent_id;
  }
  return [root, ...upward];
}

export default function FolderPicker({
  selectedId,
  onUse,
}: {
  selectedId: string | null;
  onUse: (id: string) => void;
}) {
  const [chain, setChain] = useState<FolderLevel[] | null>(null);

  useEffect(() => {
    let live = true;
    chainTo(selectedId)
      .then((next) => {
        if (live) setChain(next);
      })
      .catch(() => {
        if (live) setChain(null);
      });
    return () => {
      live = false;
    };
  }, [selectedId]);

  async function openFolder(child: FolderChild) {
    if (!child.n_folders) return;
    const next = await api.folders(child.id);
    if (!next.children.length) return;
    setChain((prev) => {
      if (!prev) return prev;
      if (prev.some((level) => level.id === child.id)) return prev;
      const i = prev.findIndex((level) => level.children.some((c) => c.id === child.id));
      const base = i >= 0 ? prev.slice(0, i + 1) : prev;
      return [...base, next];
    });
  }

  function handleUseFolder(child: FolderChild) {
    onUse(child.id);
    void openFolder(child);
  }

  if (!chain) {
    return <p className="px-2 text-xs text-muted-foreground">Loading folders</p>;
  }

  function rows(level: FolderLevel, depth: number) {
    const deeper = chain?.[depth + 1];
    return level.children.map((child) => {
      const open = deeper?.id === child.id;
      return (
        <div key={child.id} className={depth ? "pl-3" : undefined}>
          <FolderRow
            id={child.id}
            name={child.name}
            nItems={child.n_items}
            active={selectedId === child.id}
            onOpen={() =>
              open ? setChain((c) => c?.slice(0, depth + 1) ?? c) : void openFolder(child)
            }
            onUse={
              open || (child.n_items === 0 && child.n_folders === 0)
                ? undefined
                : () => handleUseFolder(child)
            }
          />
          {open ? rows(deeper, depth + 1) : null}
        </div>
      );
    });
  }

  return (
    <div data-testid="folder-switcher" className="flex flex-col gap-1 px-1">
      {rows(chain[0], 0)}
    </div>
  );
}
