import assert from "node:assert/strict";
import test from "node:test";
import { fitView, parseShareLink, safeNext, shareLinkQuery } from "../src/lib/share-link";

test("a share link round-trips with its view rounded to slide pixels", () => {
  const link = {
    dataset: "f1",
    image: "i2",
    view: { left: 10.4, top: 20.6, width: 300, height: 200 },
  };
  assert.deepEqual(parseShareLink(`?${shareLinkQuery(link)}`), {
    ...link,
    view: { left: 10, top: 21, width: 300, height: 200 },
  });
});

test("links without a usable view are ignored", () => {
  for (const search of [
    "?dataset=f&image=i&view=1,2,3",
    "?dataset=f&image=i&view=1,2,0,4",
    "?dataset=f&image=i&view=a,2,3,4",
    "?image=i&view=1,2,3,4",
  ])
    assert.equal(parseShareLink(search), null, search);
});

test("login only returns to app paths", () => {
  assert.equal(safeNext(`?next=${encodeURIComponent("/annotate?image=i")}`), "/annotate?image=i");
  assert.equal(safeNext("?next=https://evil.test"), null);
});

test("fitView fits and centers a rectangle in a differently shaped viewport", () => {
  // 1000x1000 image in a 500x250 root: fit 0.25, plane origin x 125.
  const rect = { left: 500, top: 0, width: 200, height: 100 };
  const { z, x, y } = fitView(rect, [1000, 1000], [500, 250], 20);
  assert.equal(z, 10);
  const toScreen = (px: number, py: number) => [x + (125 + px * 0.25) * z, y + py * 0.25 * z];
  assert.deepEqual(toScreen(500, 0), [0, 0]);
  assert.deepEqual(toScreen(700, 100), [500, 250]);
});
