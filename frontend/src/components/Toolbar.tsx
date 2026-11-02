"use client";

import type { ComponentProps, ReactNode } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export const toolbarChip =
  "h-8 rounded-full border-0 bg-transparent px-3 text-neutral-800 shadow-none hover:bg-black/5 hover:text-neutral-950 aria-expanded:bg-black/5 aria-expanded:text-neutral-950 focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent dark:text-neutral-100 dark:hover:bg-white/10 dark:hover:text-white dark:aria-expanded:bg-white/10 dark:aria-expanded:text-white [&>svg]:size-3.5 [&>svg]:text-neutral-500 dark:[&>svg]:text-neutral-400";
export const toolbarMenu =
  "rounded-xl border border-black/10 bg-white/90 p-1 text-neutral-800 shadow-xl shadow-black/10 ring-0 backdrop-blur-md dark:border-white/10 dark:bg-neutral-900/95 dark:text-neutral-100 dark:shadow-black/40";
export const toolbarMenuItem =
  "rounded-lg py-1.5 pl-2 focus:bg-black/5 focus:text-neutral-950 not-data-[variant=destructive]:focus:**:text-neutral-950 dark:focus:bg-white/10 dark:focus:text-white dark:not-data-[variant=destructive]:focus:**:text-white";

export function ToolbarDivider() {
  return <span aria-hidden className="mx-1 h-5 w-px bg-black/10 dark:bg-white/10" />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded bg-black/5 px-1.5 py-0.5 font-sans text-[10px] text-neutral-500 dark:bg-white/10 dark:text-neutral-400">
      {children}
    </kbd>
  );
}

export function ToolbarButton({
  label,
  shortcut,
  tone,
  className,
  ...props
}: ComponentProps<typeof Button> & {
  label: string;
  shortcut: string;
  tone?: "primary" | "secondary";
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          size="icon"
          variant="ghost"
          className={cn(
            "rounded-full",
            tone === "primary"
              ? "bg-neutral-900 text-white hover:bg-neutral-900/85 hover:text-white dark:bg-white dark:text-neutral-900 dark:hover:bg-white/85 dark:hover:text-neutral-900"
              : tone === "secondary"
                ? "bg-black/10 text-neutral-900 hover:bg-black/15 hover:text-neutral-900 dark:bg-white/15 dark:text-white dark:hover:bg-white/25 dark:hover:text-white"
                : "text-neutral-800 hover:bg-black/5 hover:text-neutral-950 dark:text-neutral-100 dark:hover:bg-white/10 dark:hover:text-white",
            className,
          )}
          {...props}
        />
      </TooltipTrigger>
      <TooltipContent side="top">
        {label}
        <Kbd>{shortcut}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
