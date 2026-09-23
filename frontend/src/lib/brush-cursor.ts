import type { Space } from "./draw";

type PointerPosition = Pick<PointerEvent, "clientX" | "clientY">;
type Origin = Pick<Space, "rootLeft" | "rootTop">;

export function createBrushCursor(outline: HTMLElement) {
  outline.hidden = true;
  const ring = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  ring.style.cssText = "position:absolute;left:0;top:0;max-width:none";
  outline.append(ring);
  let pointer: PointerPosition | null = null;
  let origin: Origin | null = null;
  let radius: number | null = null;
  let center = 0;
  let native = "crosshair";
  let oversized = false;

  function position() {
    outline.hidden = radius === null || !oversized || !pointer || !origin;
    if (outline.hidden || !pointer || !origin) return;
    ring.style.transform = `translate(${pointer.clientX - origin.rootLeft - center}px, ${pointer.clientY - origin.rootTop - center}px)`;
  }

  return {
    update(next: number | null, space: Origin | null) {
      const moved = origin?.rootLeft !== space?.rootLeft || origin?.rootTop !== space?.rootTop;
      origin = space;
      if (next === radius && !moved) return native;
      if (next !== radius) {
        radius = next;
        native = "crosshair";
        if (radius !== null) {
          center = Math.ceil(radius + 2);
          const size = center * 2;
          const circles = `<circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="#111" stroke-width="3.5"/><circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="white" stroke-width="1.5"/>`;
          // Chromium and Firefox reject native cursor images larger than 128px.
          oversized = size > 128;
          if (oversized) {
            native = "none";
            ring.setAttribute("width", String(size));
            ring.setAttribute("height", String(size));
            ring.innerHTML = circles;
          } else {
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${circles}</svg>`;
            native = `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${center} ${center}, crosshair`;
          }
        }
      }
      position();
      return native;
    },
    move(e: PointerPosition) {
      pointer = { clientX: e.clientX, clientY: e.clientY };
      position();
    },
    leave() {
      pointer = null;
      position();
    },
    destroy() {
      ring.remove();
      outline.hidden = true;
    },
  };
}
