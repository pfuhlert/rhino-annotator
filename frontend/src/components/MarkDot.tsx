import { cn } from "cn";
import type { Mark } from "@/lib/images";

export const MARK_COLOR = { annotated: "bg-sidebar-primary", visited: "bg-sidebar-primary/30" };

export default function MarkDot({ mark }: { mark: Mark | null }) {
  if (!mark) return null;
  return (
    <span
      data-testid={`mark-${mark}`}
      title={mark === "annotated" ? "Has annotations" : "Visited, no annotations"}
      className={cn("size-1.5 shrink-0 rounded-full", MARK_COLOR[mark])}
    />
  );
}
