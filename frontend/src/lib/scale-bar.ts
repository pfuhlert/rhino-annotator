import { imageToScreen, type Space } from "./draw";

const INSET = 24;
const WIDTH = 180;
const OVERLAY_HEIGHT = 28; // 20px label (leading-5) + 8px ticks (h-2).
const GAP = 12;

export function measureScaleBar(
  root: HTMLElement,
  nmPerPixel: number | null,
  space: Space | null,
  controlsTop: number,
) {
  if (!space || !nmPerPixel || !Number.isFinite(nmPerPixel) || nmPerPixel <= 0) return null;
  const [left, top] = imageToScreen([0, 0], space);
  const [right] = imageToScreen([space.imageWidth, space.imageHeight], space);
  const x = Math.max(0, left) + INSET;
  const y = controlsTop - GAP;
  if (
    x + WIDTH > Math.min(root.clientWidth, right) - INSET ||
    y - OVERLAY_HEIGHT < Math.max(0, top) + INSET
  ) return null;
  const nm = (WIDTH * nmPerPixel) / space.scale;
  const unit = nm >= 1000 ? "µm" : "nm";
  const distance = nm >= 1000 ? nm / 1000 : nm;
  return { x, y, width: WIDTH, label: `${Number(distance.toPrecision(3))} ${unit}` };
}

// Whether the opaque RGBA pixels behind the bar are light enough to need dark ink.
export function isLightBackground(pixels: Uint8ClampedArray) {
  let sum = 0;
  for (let i = 0; i < pixels.length; i += 4)
    sum += 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
  return sum / (pixels.length / 4) > 140;
}

const SAMPLE_WIDTH = 32;
const SAMPLE_HEIGHT = 4;
let sampler: CanvasRenderingContext2D | null = null;

// Downscale onto the viewer background in a tiny CPU-backed canvas and read that, so the tile canvas
// is never read back and stays GPU-accelerated.
export function sampleBehind(
  source: HTMLCanvasElement,
  bar: { x: number; y: number; width: number },
  background: string,
) {
  sampler ??= Object.assign(document.createElement("canvas"), {
    width: SAMPLE_WIDTH,
    height: SAMPLE_HEIGHT,
  }).getContext("2d", { willReadFrequently: true });
  if (!sampler) return null;
  const dpr = window.devicePixelRatio || 1;
  sampler.fillStyle = background;
  sampler.fillRect(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
  sampler.drawImage(
    source,
    bar.x * dpr,
    (bar.y - OVERLAY_HEIGHT) * dpr,
    bar.width * dpr,
    OVERLAY_HEIGHT * dpr,
    0,
    0,
    SAMPLE_WIDTH,
    SAMPLE_HEIGHT,
  );
  return sampler.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data;
}
