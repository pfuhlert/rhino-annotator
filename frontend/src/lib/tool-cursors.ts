import type { Tool } from "./draw";

// Inline data URIs apply synchronously; file URLs show the fallback until fetched.
export function svgCursor(svg: string, x: number, y: number) {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, crosshair`;
}

function outlined(path: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="${path}" stroke="#111" stroke-width="3.5"/><path d="${path}" stroke="#fff" stroke-width="1.5"/></g></svg>`;
}

const point = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g stroke="#111" stroke-width="3.5"><circle cx="12" cy="12" r="6" fill="none"/><circle cx="12" cy="12" r="1.5" fill="#111"/></g><g stroke="#fff" stroke-width="1.5"><circle cx="12" cy="12" r="6" fill="none"/><circle cx="12" cy="12" r="1.5" fill="#fff"/></g></svg>`;

export const TOOL_CURSORS: Record<Exclude<Tool, "brush" | "hand">, string> = {
  point: svgCursor(point, 12, 12),
  polygon: svgCursor(
    outlined("M4 8h8M8 4v8M27 18a7 5 0 1 1-14 0a7 5 0 1 1 14 0M15 22q4 5-2 6"),
    8,
    8,
  ),
  "ai-box": svgCursor(outlined("M4 8h8M8 4v8M15 15h12v12H15z"), 8, 8),
};
