import { imageToScreen, type Space } from "./draw";

const INSET = 24;
const WIDTH = 180;
const OVERLAY_HEIGHT = 28; // 20px label (leading-5) + 8px ticks (h-2).

export function measureScaleBar(root: HTMLElement, nmPerPixel: number | null, space: Space | null) {
  if (!space || !nmPerPixel || !Number.isFinite(nmPerPixel) || nmPerPixel <= 0) return null;
  const [left, top] = imageToScreen([0, 0], space);
  const [right, bottom] = imageToScreen([space.imageWidth, space.imageHeight], space);
  const x = Math.max(0, left) + INSET;
  const y = Math.min(root.clientHeight, bottom) - INSET;
  if (
    x + WIDTH > Math.min(root.clientWidth, right) - INSET ||
    y - OVERLAY_HEIGHT < Math.max(0, top) + INSET
  ) return null;
  const nm = (WIDTH * nmPerPixel) / space.scale;
  const unit = nm >= 1000 ? "µm" : "nm";
  const distance = nm >= 1000 ? nm / 1000 : nm;
  return { x, y, width: WIDTH, label: `${Number(distance.toPrecision(3))} ${unit}` };
}
