import assert from "node:assert/strict";
import test from "node:test";
import { parseEnabledTools } from "../src/lib/tools";

test("the hand tool starts disabled", () => {
  assert.deepEqual(parseEnabledTools(null), ["point", "polygon", "brush", "ai-box"]);
});

test("stored tools keep toolbar order and drop unknown ids", () => {
  assert.deepEqual(parseEnabledTools('["brush","lasso","hand"]'), ["hand", "brush"]);
});

test("an empty or broken setting falls back to the defaults", () => {
  for (const raw of ["[]", "nope", '{"hand":true}'])
    assert.deepEqual(parseEnabledTools(raw), ["point", "polygon", "brush", "ai-box"]);
});
