import type { ViewRect } from "./api";

// The address bar of /annotate names the dataset, image and visible slide-pixel rectangle.
export type ShareLink = { dataset: string; image: string; view: ViewRect };

export function parseShareLink(search: string): ShareLink | null {
  const params = new URLSearchParams(search);
  const dataset = params.get("dataset");
  const image = params.get("image");
  const nums = params.get("view")?.split(",").map(Number) ?? [];
  if (!dataset || !image || nums.length !== 4 || !nums.every(Number.isFinite)) return null;
  const [left, top, width, height] = nums;
  if (width <= 0 || height <= 0) return null;
  return { dataset, image, view: { left, top, width, height } };
}

export function shareLinkQuery({ dataset, image, view }: ShareLink): string {
  const rect = [view.left, view.top, view.width, view.height].map(Math.round).join(",");
  // Commas stay readable; URLSearchParams would encode them as %2C.
  return new URLSearchParams({ dataset, image, view: rect }).toString().replaceAll("%2C", ",");
}

// Only same-app paths, so a crafted login link cannot redirect elsewhere.
export function safeNext(search: string): string | null {
  const next = new URLSearchParams(search).get("next");
  return next && /^\/(annotate|projects)([?/]|$)/.test(next) ? next : null;
}

// Zoom and pan of the top-left-origin image plane that fit `rect` (patch pixels) in the root.
export function fitView(
  rect: ViewRect,
  [imageWidth, imageHeight]: [number, number],
  [rootWidth, rootHeight]: [number, number],
  maxZoom: number,
): { z: number; x: number; y: number } {
  const fit = Math.min(rootWidth / imageWidth, rootHeight / imageHeight);
  const z = Math.min(
    maxZoom,
    Math.max(1, Math.min(rootWidth / (rect.width * fit), rootHeight / (rect.height * fit))),
  );
  const cx = (rootWidth - imageWidth * fit) / 2 + (rect.left + rect.width / 2) * fit;
  const cy = (rootHeight - imageHeight * fit) / 2 + (rect.top + rect.height / 2) * fit;
  return { z, x: rootWidth / 2 - cx * z, y: rootHeight / 2 - cy * z };
}
