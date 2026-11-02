"use client";

import { Popover, Slider } from "radix-ui";
import { cn } from "cn";
import { toolbarChip, toolbarMenu } from "@/components/Toolbar";
import { Button } from "@/components/ui/button";
import { BRUSH_MAX, BRUSH_MIN, BRUSH_STEP } from "@/lib/brush";

export function BrushSizeControl({
  value,
  onChange,
  open,
  onOpenChange,
}: {
  value: number;
  onChange: (n: number) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <Button
          data-testid="brush-size"
          variant="ghost"
          size="icon"
          aria-label="Brush size"
          className={cn(toolbarChip, "w-8 px-0 [&>svg]:size-4 [&>svg]:text-current")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <circle cx="12" cy="12" r="10" />
            <circle cx="12" cy="12" r="4" />
          </svg>
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          sideOffset={8}
          className={cn(toolbarMenu, "z-50 flex items-center px-1.5 py-2.5 outline-hidden")}
        >
          <Slider.Root
            data-testid="brush-size-slider"
            orientation="vertical"
            min={BRUSH_MIN}
            max={BRUSH_MAX}
            step={BRUSH_STEP}
            value={[value]}
            onValueChange={([n]) => onChange(n)}
            className="relative h-40 w-3 touch-none"
          >
            <Slider.Track className="absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 rounded-full bg-black/10 dark:bg-white/15">
              <Slider.Range className="absolute w-full bg-neutral-900 dark:bg-white" />
            </Slider.Track>
            <Slider.Thumb
              aria-label="Brush size"
              className="block size-3 rounded-full border border-black/20 bg-white shadow-sm dark:border-white/40"
            />
          </Slider.Root>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
