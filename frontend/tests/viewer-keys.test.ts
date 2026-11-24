import assert from "node:assert/strict";
import test from "node:test";
import { viewAction } from "../src/lib/viewer-keys";

const key = (k: string, extra: Partial<KeyboardEvent> = {}) => ({
  key: k,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...extra,
});

test("keys move the view as in OpenSeadragon", () => {
  assert.deepEqual(viewAction(key("ArrowUp")), { pan: [0, -40] });
  assert.deepEqual(viewAction(key("ArrowRight")), { pan: [40, 0] });
  for (const k of ["+", "="]) assert.deepEqual(viewAction(key(k)), { zoom: 1.1 });
  for (const k of ["-", "_"]) assert.deepEqual(viewAction(key(k)), { zoom: 0.9 });
  assert.deepEqual(viewAction(key("ArrowUp", { shiftKey: true })), { zoom: 1.1 });
  assert.deepEqual(viewAction(key("ArrowDown", { shiftKey: true })), { zoom: 0.9 });
  assert.equal(viewAction(key("Home")), "home");
});

test("browser shortcuts and the editor's own keys do not move the view", () => {
  for (const k of ["+", "-", "Home"]) assert.equal(viewAction(key(k, { ctrlKey: true })), null);
  assert.equal(viewAction(key("ArrowLeft", { altKey: true })), null);
  for (const k of ["0", "1", "a", "s", "n", "b", "p", "l", "r", "h", "Tab", "Escape"])
    assert.equal(viewAction(key(k)), null);
});
