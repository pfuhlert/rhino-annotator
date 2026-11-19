import assert from "node:assert/strict";
import test from "node:test";
import { TWO_DIGIT_MS, digitScore, scoreKey } from "../src/lib/scores";

const key = (k: string, extra: Partial<KeyboardEvent> = {}) => ({
  key: k,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...extra,
});

test("a digit scores in tens and a quick second digit makes a two-digit score", () => {
  const first = digitScore(9, 1000, null);
  assert.equal(first.value, 90);
  assert.equal(digitScore(5, 1000 + TWO_DIGIT_MS, first.state).value, 95);
  assert.equal(digitScore(5, 1001 + TWO_DIGIT_MS, first.state).value, 50);
  assert.equal(digitScore(5, 1100, digitScore(0, 1000, null).state).value, 5);
  assert.equal(digitScore(0, 1100, digitScore(1, 1000, null).state).value, 100);
  // A two-digit score is complete; the next digit starts over.
  const done = digitScore(5, 1100, first.state);
  assert.equal(digitScore(3, 1200, done.state).value, 30);
});

test("score keys", () => {
  assert.equal(scoreKey(key("7")), 7);
  assert.equal(scoreKey(key("7", { repeat: true })), null);
  assert.equal(scoreKey(key("7", { ctrlKey: true })), null);
  assert.deepEqual(scoreKey(key("x")), { kind: "set", value: "na" });
  assert.deepEqual(scoreKey(key("Enter")), { kind: "next" });
  assert.deepEqual(scoreKey(key("Enter", { shiftKey: true })), { kind: "prev" });
  assert.deepEqual(scoreKey(key("S", { shiftKey: true })), { kind: "class", step: -1 });
  // Drawing and navigation keys stay with the editor.
  for (const k of ["n", "b", "p", "l", "r", "a", "h", "Delete", "Escape"])
    assert.equal(scoreKey(key(k)), null);
});
