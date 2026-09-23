import { imagePoint, imageScreenRect, type PointerPosition, type Space } from "./draw";
import { brushTouchesImage } from "./image-bounds";

export function createBrushCursor(outline: HTMLElement) {
  outline.hidden = true;
  const ring = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  ring.style.cssText = "position:absolute;left:0;top:0;max-width:none";
  outline.append(ring);
  let cachedSpace: Space | null = null;
  let radius = 0;
  let center = 0;
  let native = "crosshair";

  function hide(cursor: string) {
    if (!outline.hidden) outline.hidden = true;
    return cursor;
  }

  return {
    update(pointer: PointerPosition | null, space: Space | null, next: number | null = null) {
      if (!pointer || !space || next === null) return hide("crosshair");
      if (next !== radius) {
        radius = next;
        center = Math.ceil(radius + 2);
        const size = center * 2;
        const circles = `<circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="#111" stroke-width="3.5"/><circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="white" stroke-width="1.5"/>`;
        ring.setAttribute("width", String(size));
        ring.setAttribute("height", String(size));
        ring.innerHTML = circles;
        // Chromium and Firefox reject native cursor images larger than 128px.
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${circles}</svg>`;
        native =
          size > 128
            ? "none"
            : `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${center} ${center}, crosshair`;
      }
      const point = imagePoint(pointer, space);
      if (!brushTouchesImage(point, radius / space.scale, space)) return hide("not-allowed");
      const margin = (radius + 2) / space.scale;
      if (
        native !== "none" &&
        point[0] >= margin &&
        point[1] >= margin &&
        point[0] <= space.imageWidth - margin &&
        point[1] <= space.imageHeight - margin
      )
        return hide(native);
      if (space !== cachedSpace) {
        const { left, top, right, bottom } = imageScreenRect(space);
        outline.style.clipPath = `polygon(${left}px ${top}px, ${right}px ${top}px, ${right}px ${bottom}px, ${left}px ${bottom}px)`;
        cachedSpace = space;
      }
      if (outline.hidden) outline.hidden = false;
      ring.style.transform = `translate(${pointer.clientX - space.rootLeft - center}px, ${pointer.clientY - space.rootTop - center}px)`;
      return "none";
    },
    destroy() {
      ring.remove();
      outline.hidden = true;
    },
  };
}
