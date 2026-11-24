import assert from "node:assert/strict";
import test from "node:test";
import { scrollZoomFactor, wheelZoomFactor } from "../src/lib/wheel-zoom";

test("a short trackpad pinch zooms noticeably while a mouse notch stays gentle", () => {
  // ~20 pinch events of 3px is a quick, small pinch on a trackpad.
  assert.ok(wheelZoomFactor(-3, 0) ** 20 > 2);
  assert.ok(wheelZoomFactor(-100, 0) < 1.3);
  assert.ok(wheelZoomFactor(-3, 1) > 1.2);
});

test("a plain scroll notch zooms like OpenSeadragon and small trackpad steps stay gentle", () => {
  assert.equal(scrollZoomFactor(-120, 0), 1.2);
  assert.equal(scrollZoomFactor(120, 0), 1 / 1.2);
  assert.equal(scrollZoomFactor(-3, 1), 1.2);
  assert.ok(scrollZoomFactor(-4, 0) < 1.01);
  assert.equal(scrollZoomFactor(0, 0), 1);
});
