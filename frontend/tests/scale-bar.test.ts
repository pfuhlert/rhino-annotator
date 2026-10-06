import assert from "node:assert/strict";
import test from "node:test";
import { isLightBackground, measureScaleBar } from "../src/lib/scale-bar";
import { measureSpace } from "../src/lib/draw";

function viewer({ imageWidth = 2000, imageHeight = 1000, width = 1000, height = 800, zoom = 1, x = 0, y = 0 } = {}) {
  return {
    clientWidth: width,
    clientHeight: height,
    getBoundingClientRect: () => ({ left: 200, top: 50 }),
    querySelector: () => ({
      dataset: { width: String(imageWidth), height: String(imageHeight) },
      getBoundingClientRect: () => ({ left: 200 + x, top: 50 + y, width: width * zoom, height: height * zoom }),
    }),
  } as unknown as HTMLElement;
}

function scaleBar(root: HTMLElement, nmPerPixel: number | null, controlsTop = 740) {
  return measureScaleBar(root, nmPerPixel, measureSpace(root), controlsTop);
}

test("bar follows the left edge of landscape and portrait images, inside letterboxing", () => {
  const landscape = scaleBar(viewer(), 2)!;
  assert.deepEqual(landscape, { x: 24, y: 728, width: 180, label: "720 nm" });
  const portrait = scaleBar(viewer({ imageWidth: 1000, imageHeight: 2000 }), 2)!;
  assert.deepEqual(portrait, { x: 324, y: 728, width: 180, label: "900 nm" });
});

test("zoom changes distance, keeps bar length, and anchors to the visible crop", () => {
  const fit = scaleBar(viewer(), 4.8828125)!;
  const zoomed = scaleBar(viewer({ zoom: 2, x: -500, y: -400 }), 4.8828125)!;
  assert.equal(fit.label, "1.76 µm");
  assert.equal(zoomed.label, "879 nm");
  assert.equal(zoomed.width, fit.width);
  assert.equal(zoomed.x, 24);
});

test("panning preserves the distance and keeps the bar in the visible crop", () => {
  const topLeft = scaleBar(viewer({ zoom: 2, y: -300 }), 2)!;
  const bottomRight = scaleBar(viewer({ zoom: 2, x: -1000, y: -500 }), 2)!;
  assert.deepEqual(topLeft, bottomRight);
});

test("resize updates the scale", () => {
  const bar = scaleBar(viewer({ width: 800, height: 800 }), 2)!;
  assert.deepEqual(bar, { x: 24, y: 728, width: 180, label: "900 nm" });
});

test("switching calibration uses the image's own physical scale", () => {
  assert.equal(scaleBar(viewer(), 0.48828125)!.label, "176 nm");
  assert.equal(scaleBar(viewer(), 4.8828125)!.label, "1.76 µm");
});

test("no misleading bar without calibration, a loaded image, or room to draw it", () => {
  for (const calibration of [null, 0, -1, NaN, Infinity])
    assert.equal(scaleBar(viewer(), calibration), null);
  assert.equal(scaleBar(viewer({ imageWidth: 0 }), 2), null);
  assert.equal(scaleBar(viewer({ width: 140 }), 2), null);
});

test("bar sits a gap above the controls even below a letterboxed image, and hides without room", () => {
  // Landscape image ends at y=650; the bar still follows the controls.
  assert.equal(scaleBar(viewer(), 2, 740)!.y, 728);
  assert.equal(scaleBar(viewer(), 2, 790)!.y, 778);
  assert.equal(scaleBar(viewer(), 2, 200), null);
});

test("picks ink from the average brightness behind the bar", () => {
  const px = (...rgba: number[][]) => new Uint8ClampedArray(rgba.flat());
  assert.equal(isLightBackground(px([240, 230, 235, 255], [200, 200, 200, 255])), true);
  assert.equal(isLightBackground(px([60, 20, 80, 255], [240, 230, 235, 255])), false);
});
