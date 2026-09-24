import type { Box } from "./api";
import { polyRings, shiftMark, type Mark, type Space } from "./draw";

type Point = [number, number];
type Size = Pick<Space, "imageWidth" | "imageHeight">;

export function clampToImage([x, y]: Point, size: Size): Point {
  return [Math.max(0, Math.min(size.imageWidth, x)), Math.max(0, Math.min(size.imageHeight, y))];
}

export function imageBox(a: Point, b: Point, size: Size): Box | null {
  const [ax, ay] = clampToImage(a, size).map(Math.round);
  const [bx, by] = clampToImage(b, size).map(Math.round);
  const box: Box = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
  return box[2] - box[0] >= 2 && box[3] - box[1] >= 2 ? box : null;
}

export function insideImageBounds([x, y]: Point, size: Size) {
  return x >= 0 && y >= 0 && x <= size.imageWidth && y <= size.imageHeight;
}

export function insidePixelBounds([x, y]: Point, size: Size) {
  return x >= 0 && y >= 0 && x < size.imageWidth && y < size.imageHeight;
}

export function brushTouchesImage(point: Point, radius: number, size: Size) {
  const nearest = clampToImage(point, size);
  return Math.hypot(point[0] - nearest[0], point[1] - nearest[1]) < radius;
}

export function moveWithinImage(mark: Mark, dx: number, dy: number, size: Size): Point | null {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const ring of polyRings(mark)) {
    for (const [x, y] of ring) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  const inset = mark.type === "point" ? 1 : 0;
  dx = Math.max(-minX, Math.min(size.imageWidth - inset - maxX, dx));
  dy = Math.max(-minY, Math.min(size.imageHeight - inset - maxY, dy));
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) return null;
  shiftMark(mark, dx, dy);
  return [dx, dy];
}
