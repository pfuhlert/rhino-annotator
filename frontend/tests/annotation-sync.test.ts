import assert from "node:assert/strict";
import test from "node:test";
import { createAnnotationSync, type Changes } from "../src/lib/annotation-sync";
import type { Element } from "../src/lib/api";

const point = (id: string, x = 10): Element => ({ id, type: "point", points: [[x, 10]], jobId: 1 });

test("saving a manual edit never deletes an unseen background annotation", async () => {
  const writes: Changes[] = [];
  const sync = createAnnotationSync([point("manual")], async (c) => {
    writes.push(c);
  });
  await sync.save([point("manual", 20)]);
  assert.deepEqual(writes, [{ upsert: [point("manual", 20)], delete: [] }]);
});

test("background completion during a save is preserved and undo deletes only its annotation", async () => {
  let release!: () => void;
  const writes: Changes[] = [];
  const sync = createAnnotationSync([point("manual")], async (c) => {
    writes.push(c);
    if (writes.length === 1)
      await new Promise<void>((r) => {
        release = r;
      });
  });
  const saving = sync.save([point("manual", 20)]);
  sync.accept([point("ai")]);
  void sync.save([point("manual", 30), point("ai")]);
  release();
  await saving;
  assert.deepEqual(writes[1], { upsert: [point("manual", 30)], delete: [] });
  await sync.save([point("manual", 30)]);
  assert.deepEqual(writes[2], { upsert: [], delete: ["ai"] });
});

test("failed saves retain edits for retry and coalesce subsequent corrections", async () => {
  let fail = true;
  const writes: Changes[] = [];
  const sync = createAnnotationSync([point("a"), point("b")], async (c) => {
    if (fail) throw new Error("offline");
    writes.push(c);
  });
  await assert.rejects(sync.save([point("a", 20)]));
  fail = false;
  await sync.save([point("a", 30)]);
  assert.deepEqual(writes, [{ upsert: [point("a", 30)], delete: ["b"] }]);
});
