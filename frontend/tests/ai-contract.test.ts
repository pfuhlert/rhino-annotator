import assert from "node:assert/strict";
import test from "node:test";
import { aiTaskId } from "../src/lib/api";

test("AI annotation IDs identify the queue task; manual IDs do not", () => {
  const taskId = "b92484e4-dbbd-4e3c-b5cf-7a3ff393013a";
  assert.equal(aiTaskId(`ai-${taskId}`), taskId);
  assert.equal(aiTaskId(taskId), null);
  assert.equal(aiTaskId("legacy-12-0"), null);
});
