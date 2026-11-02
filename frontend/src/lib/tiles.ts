import type { PatchImage, ViewRect } from "./api";
import { imageScreenRect, imageToScreen, setupCanvas, type Space } from "./draw";

export type TileKey = { z: number; x: number; y: number };

const CACHE_SIZE = 384;
// Coarser cached levels fill in while the current level loads.
const FALLBACK_LEVELS = 3;

// Level z is downsampled by 2^(levels - 1 - z). Pick the coarsest level that still has at least
// one tile pixel per device pixel.
export function pickLevel(devicePerImagePixel: number, levels: number): number {
  const down = Math.floor(Math.log2(Math.max(1, 1 / devicePerImagePixel)));
  return Math.max(0, levels - 1 - down);
}

export function downsample(image: PatchImage, z: number) {
  return 2 ** (image.levels - 1 - z);
}

// The part of the patch on screen, in patch pixels.
export function visibleRect(space: Space, rootWidth: number, rootHeight: number): ViewRect {
  const [ox, oy] = imageToScreen([0, 0], space);
  const left = Math.max(0, -ox / space.scale);
  const top = Math.max(0, -oy / space.scale);
  const right = Math.min(space.imageWidth, (rootWidth - ox) / space.scale);
  const bottom = Math.min(space.imageHeight, (rootHeight - oy) / space.scale);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export function visibleTiles(image: PatchImage, z: number, view: ViewRect): TileKey[] {
  const down = downsample(image, z);
  const tw = image.tile_width * down;
  const th = image.tile_height * down;
  const x0 = image.left + view.left;
  const y0 = image.top + view.top;
  const x1 = Math.min(image.slide_width, x0 + view.width);
  const y1 = Math.min(image.slide_height, y0 + view.height);
  const tiles: TileKey[] = [];
  for (let y = Math.floor(y0 / th); y * th < y1; y++) {
    for (let x = Math.floor(x0 / tw); x * tw < x1; x++) tiles.push({ z, x, y });
  }
  return tiles;
}

// Drop least recently used entries beyond `size`, but never ones the current view needs.
export function evict<K, V>(cache: Map<K, V>, keep: Set<K>, size: number) {
  for (const key of cache.keys()) {
    if (cache.size <= size) return;
    if (!keep.has(key)) cache.delete(key);
  }
}

export function createTileLayer(
  canvas: HTMLCanvasElement,
  root: HTMLElement,
  image: PatchImage,
  events: { onLoad: () => void; onError: () => void; onDraw?: () => void },
) {
  const cache = new Map<string, HTMLImageElement>();
  let space: Space | null = null;
  let frame = 0;
  let loaded = false;
  // A failed tile reports an error until a later draw has every visible tile again.
  let broken = false;

  function tile({ z, x, y }: TileKey, request: boolean) {
    const key = `${z}/${x}/${y}`;
    let img = cache.get(key);
    if (img) {
      cache.delete(key);
      cache.set(key, img);
      return img.complete && img.naturalWidth ? img : null;
    }
    if (!request) return null;
    img = new Image();
    img.onload = schedule;
    img.onerror = () => {
      cache.delete(key);
      if (!broken) events.onError();
      broken = true;
    };
    img.src = image.tile_url
      .replace("{z}", String(z))
      .replace("{x}", String(x))
      .replace("{y}", String(y));
    cache.set(key, img);
    return null;
  }

  function draw() {
    frame = 0;
    const ctx = setupCanvas(canvas, root);
    if (!ctx) return;
    ctx.clearRect(0, 0, root.clientWidth, root.clientHeight);
    if (!space) return;
    const s = space;
    const view = visibleRect(s, root.clientWidth, root.clientHeight);
    const target = pickLevel(s.scale * (window.devicePixelRatio || 1), image.levels);
    const coarsest = Math.max(0, target - FALLBACK_LEVELS);
    const { left, top, right, bottom } = imageScreenRect(s);
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, right - left, bottom - top);
    ctx.clip();
    const needed = new Set<string>();
    // Request coarse tiles first so gaps fill quickly.
    const levels: { key: TileKey; img: HTMLImageElement | null }[][] = [];
    for (let z = coarsest; z <= target; z++) {
      levels.push(
        visibleTiles(image, z, view).map((key) => {
          needed.add(`${key.z}/${key.x}/${key.y}`);
          return { key, img: tile(key, z === target || z === coarsest) };
        }),
      );
    }
    // Coarser levels only fill gaps, and rasterizing them is the main cost of a frame, so skip
    // those under the finest level that covers the view.
    const covering = levels.findLastIndex((level) => level.every((t) => t.img));
    const complete = covering === levels.length - 1;
    for (const level of levels.slice(Math.max(0, covering))) {
      for (const { key, img } of level) {
        if (!img) continue;
        const down = downsample(image, key.z);
        const [x, y] = imageToScreen(
          [
            key.x * image.tile_width * down - image.left,
            key.y * image.tile_height * down - image.top,
          ],
          s,
        );
        // Snap outward to whole pixels so neighbouring tiles never leave a seam.
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const x1 = Math.ceil(x + img.naturalWidth * down * s.scale);
        const y1 = Math.ceil(y + img.naturalHeight * down * s.scale);
        ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0);
      }
    }
    ctx.restore();
    evict(cache, needed, CACHE_SIZE);
    events.onDraw?.();
    if (complete && (!loaded || broken)) {
      loaded = true;
      broken = false;
      events.onLoad();
    }
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  return {
    update(next: Space | null) {
      space = next;
      // Draw now so tiles stay in the same frame as the annotations drawn alongside them.
      cancelAnimationFrame(frame);
      draw();
    },
    destroy() {
      cancelAnimationFrame(frame);
      for (const img of cache.values()) img.onload = img.onerror = null;
      cache.clear();
    },
  };
}
