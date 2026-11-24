"use client";

import { XIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import type { Tool } from "@/lib/draw";
import { TOOLS, useEnabledTools } from "@/lib/tools";

export const MOD = "Ctrl/⌘";

const SECTIONS: [string, [string[][], string, Tool?][]][] = [
  [
    "Navigation",
    [
      [[["N"], ["F"]], "Next region or image"],
      [[["B"]], "Previous region or image"],
    ],
  ],
  [
    "Views",
    [
      [[["V"]], "Switch between the Masks and Scores views (projects with both)"],
      [[["1"], ["…"], ["9"], ["0"]], "Masks view: pick structure 1–10 from the top bar"],
      [[["C"]], "Masks view: mark the image complete, or not"],
    ],
  ],
  [
    "Scores view",
    [
      [
        [["0"], ["…"], ["9"]],
        "Score 0–90; type two digits quickly for any value (9 5 → 95, 1 0 → 100)",
      ],
      [[["X"]], "Not scorable"],
      [[["S"], ["Shift", "S"]], "Next / previous score class"],
      [[["Enter"], ["Shift", "Enter"]], "Next / previous image"],
    ],
  ],
  [
    "Tools",
    [
      ...TOOLS.map(([id, label, key]): [string[][], string, Tool] => [[[key]], label, id]),
      [[["Tab"], ["Shift", "Tab"]], "Next / previous tool"],
    ],
  ],
  [
    "Editing",
    [
      [[[MOD, "Z"]], "Undo"],
      [
        [
          [MOD, "Y"],
          [MOD, "Shift", "Z"],
        ],
        "Redo",
      ],
      [[[MOD, "Click"]], "Select the mask under the brush"],
      [[["Delete"], ["Backspace"]], "Delete selected annotation"],
      [[["Esc"]], "Cancel drawing, deselect, or cancel the latest AI request"],
      [[["["], ["]"]], "Smaller / larger brush"],
      [[["Shift", "Scroll"]], "Resize brush"],
      [[["Shift", "Drag"], ["Right-drag"]], "Erase with the brush"],
    ],
  ],
  [
    "View",
    [
      [[["Scroll"], ["+"], ["−"]], "Zoom"],
      [
        [
          ["Shift", "↑"],
          ["Shift", "↓"],
        ],
        "Zoom in / out",
      ],
      [[["Space", "Drag"], ["Middle-drag"]], "Pan when zoomed in"],
      [[["↑"], ["↓"], ["←"], ["→"]], "Pan by a step"],
      [[["Home"]], "Show the whole image"],
      [[["Click"], ["Shift", "Click"]], "Hand tool: zoom in / out"],
      [[["?"]], "Show this list"],
    ],
  ],
];

function Keys({ combos }: { combos: string[][] }) {
  return (
    <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
      {combos.map((combo, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <span className="text-xs text-muted-foreground">or</span>}
          {combo.map((key) => (
            <kbd
              key={key}
              className="min-w-5 rounded border border-border bg-muted px-1 text-center font-sans text-[11px] leading-5 font-medium"
            >
              {key}
            </kbd>
          ))}
        </span>
      ))}
    </span>
  );
}

export default function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const enabledTools = useEnabledTools();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          data-testid="shortcuts-dialog"
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-[min(32rem,calc(100vw-2rem))] -translate-1/2 flex-col rounded-xl bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <Dialog.Title className="text-sm font-semibold">Keyboard shortcuts</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <XIcon className="size-4" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">
            Keyboard and mouse shortcuts for annotating.
          </Dialog.Description>
          <div className="flex flex-col gap-4 overflow-auto px-4 py-3">
            {SECTIONS.map(([title, rows]) => (
              <section key={title} className="flex flex-col gap-1">
                <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
                {rows.map(([combos, label, tool]) => (
                  <div
                    key={label}
                    className={`flex items-center justify-between gap-4 py-0.5 text-sm ${tool && !enabledTools.includes(tool) ? "opacity-40" : ""}`}
                  >
                    <span>{label}</span>
                    <Keys combos={combos} />
                  </div>
                ))}
              </section>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
