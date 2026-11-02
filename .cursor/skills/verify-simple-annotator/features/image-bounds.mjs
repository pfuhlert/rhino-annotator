import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

const artifacts =
  ".cursor/skills/verify-simple-annotator/artifacts/image-bounds";

export default async function (page, state) {
  await page.goto("/annotate");
  const root = page.getByTestId("patch-canvas");
  await root.waitFor();
  const ready = () =>
    page.waitForFunction(() => {
      const img = document.querySelector('[data-testid="patch-canvas"] [data-image-plane]');
      return img?.dataset.loaded === 'true';
    });
  const results = [];
  const readPatch = async () => {
    const response = await page.request.get(`${state.webUrl}/patches/current`);
    assert.ok(response.ok());
    return response.json();
  };
  async function saved(label, action) {
    const response = page.waitForResponse(
      (r) => /\/annotations(\?|$)/.test(r.url()) && r.request().method() === "PATCH",
    );
    await action();
    assert.ok((await response).ok(), label);
    const patch = await readPatch();
    results.push({ label, patch });
    return patch.elements;
  }
  // The placeholder dataset is one image shown whole, so clear it instead of moving on.
  async function fresh() {
    const patch = await readPatch();
    const ids = patch.elements.map((el) => el.id);
    if (ids.length) {
      const cleared = await page.request.patch(
        `${state.webUrl}/patches/${patch.id}/annotations`,
        { data: { delete: ids } },
      );
      assert.ok(cleared.ok());
    }
    await page.reload();
    await ready();
    await page.getByTestId("sidebar-trigger").click();
  }
  async function bounds() {
    return root.evaluate((el) => {
      const img = el.querySelector("[data-image-plane]"),
        r = img.getBoundingClientRect();
      const scale = Math.min(
        r.width / Number(img.dataset.width),
        r.height / Number(img.dataset.height),
      );
      return {
        left: r.left + (r.width - Number(img.dataset.width) * scale) / 2,
        top: r.top + (r.height - Number(img.dataset.height) * scale) / 2,
        width: Number(img.dataset.width),
        height: Number(img.dataset.height),
        scale,
      };
    });
  }
  let image = await bounds();
  async function move(x, y, steps = 1) {
    await page.mouse.move(
      image.left + x * image.scale,
      image.top + y * image.scale,
      { steps },
    );
  }
  async function drag(points) {
    await move(...points[0]);
    await page.mouse.down();
    for (const p of points.slice(1)) await move(...p, 8);
    await page.mouse.up();
  }
  async function zoomAt(x, y, deltaY) {
    await root.dispatchEvent("wheel", {
      clientX: image.left + x * image.scale,
      clientY: image.top + y * image.scale,
      deltaY,
      ctrlKey: true,
    });
    image = await bounds();
  }
  const canvasImage = () =>
    root.evaluate((el) => el.querySelector('[data-testid="patch-marks"]').toDataURL());
  const cursor = () => root.evaluate((el) => getComputedStyle(el).cursor);
  const bounded = (elements) => {
    for (const mark of elements)
      for (const ring of [mark.points, ...(mark.holes ?? [])])
        for (const [x, y] of ring)
          assert.ok(
            x >= 0 && y >= 0 && x <= image.width && y <= image.height,
            `${x}, ${y} outside image`,
          );
  };
  const alpha = (x, y) =>
    root.evaluate(
      (el, p) => {
        const canvas = el.querySelector('[data-testid="patch-marks"]'),
          rect = canvas.getBoundingClientRect();
        return canvas
          .getContext("2d")
          .getImageData(
            Math.floor(((p.x - rect.x) * canvas.width) / rect.width),
            Math.floor(((p.y - rect.y) * canvas.height) / rect.height),
            1,
            1,
          ).data[3];
      },
      { x: image.left + x * image.scale, y: image.top + y * image.scale },
    );

  // Start on an empty patch, including when the script is rerun.
  await fresh();
  image = await bounds();
  await move(-100, 350);
  for (const key of ["p", "l", "r"]) {
    await page.keyboard.press(key);
    assert.equal(
      await cursor(),
      "not-allowed",
      `${key}: switching tools in the margin`,
    );
    await page.mouse.down();
    await page.mouse.up();
  }
  await page.keyboard.press("l");
  await drag([
    [-100, 350],
    [200, 350],
    [250, 500],
  ]);
  await page.waitForTimeout(350);
  assert.deepEqual(
    (await readPatch()).elements,
    [],
    "outside gestures must not start annotations",
  );
  results.push({ label: "outside cursors and gestures are inactive" });

  // New Point gestures invoke AI; seed a legacy point to exercise its editing boundaries.
  const patch = await readPatch();
  const seeded = await page.request.patch(`${state.webUrl}/patches/${patch.id}/annotations`, {
    data: { upsert: [{ id: "legacy-point-fixture", jobId: patch.job_id, type: "point", points: [[500, 350]] }] },
  });
  assert.ok(seeded.ok());
  await page.reload();
  await ready();
  await page.getByTestId("sidebar-trigger").click();
  await page.keyboard.press("p");
  image = await bounds();
  const point = (await readPatch()).elements;
  results.push({ label: "legacy point fixture for editing", point });
  assert.equal(point.length, 1);
  assert.equal(point[0].type, "point");
  await move(501, 350);
  await page.keyboard.press("r");
  await move(-100, 350);
  await page.keyboard.press("p");
  assert.equal(
    await cursor(),
    "not-allowed",
    "tool switching clears stale annotation hover",
  );
  const movedPoint = await saved(
    "point stays pinned until the pointer catches up",
    async () => {
      await move(500, 350);
      await page.mouse.down();
      await move(-100, 350, 8);
      const pinned = await canvasImage();
      await move(-50, 350, 8);
      assert.equal(
        await canvasImage(),
        pinned,
        "reversing in the margin must keep the point pinned",
      );
      await move(20, 350, 8);
      assert.notEqual(
        await canvasImage(),
        pinned,
        "the point follows once the pointer catches up",
      );
      await move(0, 350, 8);
      await page.mouse.up();
    },
  );
  assert.equal(movedPoint[0].points[0][0], 0);
  bounded(movedPoint);
  await zoomAt(500, 350, -150);
  await move(1, 350);
  assert.equal(await cursor(), "grab");
  const viewport = page.viewportSize();
  await page.setViewportSize({
    width: viewport.width + 160,
    height: viewport.height,
  });
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('[data-testid="patch-canvas"]'))
        .cursor === "not-allowed",
  );
  image = await bounds();
  await move(1, 350);
  assert.equal(await cursor(), "grab");
  await zoomAt(1, 350, 1500);
  assert.equal(
    await cursor(),
    "not-allowed",
    "zooming out clears stale point hover without pointer movement",
  );
  await page.setViewportSize(viewport);
  image = await bounds();
  results.push({
    label: "stationary point hover refreshes after resize and zoom",
  });
  const cornerPoint = await saved(
    "point drag stops on a valid bottom-right pixel",
    () =>
      drag([
        [0, 350],
        [1200, 1200],
      ]),
  );
  assert.deepEqual(cornerPoint[0].points[0], [
    image.width - 1,
    image.height - 1,
  ]);

  await fresh();
  image = await bounds();
  await page.keyboard.press("l");
  const polygon = await saved(
    "polygon slides along left edge and finishes outside",
    async () => {
      await move(180, 220);
      await page.mouse.down();
      for (const p of [
        [200, 500],
        [-100, 500],
        [-100, 200],
      ])
        await move(...p, 8);
      assert.equal(await alpha(-10, 350), 0, "draft stays inside the image");
      await page.screenshot({ path: `${artifacts}-polygon-draft.png` });
      await page.mouse.up();
    },
  );
  assert.equal(polygon.length, 1);
  bounded(polygon);
  assert.ok(polygon[0].points.filter(([x]) => x === 0).length >= 2);
  assert.equal(
    await cursor(),
    "not-allowed",
    "release outside restores the unavailable cursor",
  );
  await zoomAt(500, 350, -150);
  await move(0, 350);
  assert.equal(await cursor(), "copy");
  await zoomAt(0, 350, 1500);
  assert.equal(
    await cursor(),
    "not-allowed",
    "zooming out clears stale edge insertion without pointer movement",
  );
  results.push({ label: "stationary polygon edge hover refreshes after zoom" });
  const translated = await saved(
    "whole polygon preserves the grab offset at the edge",
    async () => {
      await move(80, 350);
      await page.mouse.down();
      await move(700, -100, 8);
      const pinned = await canvasImage();
      await move(700, -20, 8);
      assert.equal(
        await canvasImage(),
        pinned,
        "reversing outside must keep the polygon pinned",
      );
      await move(700, 120, 8);
      assert.equal(
        await canvasImage(),
        pinned,
        "entering the image must preserve the grab offset",
      );
      await page.screenshot({ path: artifacts + "-polygon-pinned.png" });
      await move(700, 170, 8);
      assert.notEqual(
        await canvasImage(),
        pinned,
        "the polygon follows once the pointer catches up",
      );
      await page.mouse.up();
    },
  );
  bounded(translated);
  const dx = translated[0].points[0][0] - polygon[0].points[0][0];
  const dy = translated[0].points[0][1] - polygon[0].points[0][1];
  for (let i = 0; i < polygon[0].points.length; i++) {
    assert.ok(
      Math.abs(translated[0].points[i][0] - polygon[0].points[i][0] - dx) <
        1e-6,
    );
    assert.ok(
      Math.abs(translated[0].points[i][1] - polygon[0].points[i][1] - dy) <
        1e-6,
    );
  }
  assert.ok(
    Math.abs(Math.min(...translated[0].points.map((p) => p[1])) - 20) < 1e-6,
  );
  const vertex = translated[0].points.reduce((a, b) => (b[1] > a[1] ? b : a));
  const edited = await saved("vertex stops at the right edge", () =>
    drag([vertex, [1200, 500]]),
  );
  bounded(edited);
  assert.ok(edited[0].points.some(([x]) => x === image.width));
  const undone = await saved("undo constrained vertex edit", () =>
    page.keyboard.press("Control+z"),
  );
  assert.deepEqual(undone, translated);
  const redone = await saved("redo constrained vertex edit", () =>
    page.keyboard.press("Control+Shift+z"),
  );
  assert.deepEqual(redone, edited);
  await page.reload();
  await ready();
  await page.getByTestId("sidebar-trigger").click();
  assert.deepEqual(
    (await readPatch()).elements,
    edited,
    "bounded geometry survives reload",
  );

  await fresh();
  image = await bounds();
  await page.keyboard.press("r");
  await move(-8, 350);
  assert.equal(
    await cursor(),
    "none",
    "overlapping brush uses a clipped outline",
  );
  assert.equal(
    await page.getByTestId("brush-cursor").evaluate((el) => el.hidden),
    false,
  );
  await page.screenshot({ path: `${artifacts}-brush-edge.png` });
  const brush = await saved(
    "brush paints the overlapping footprint",
    async () => {
      await page.mouse.down();
      assert.equal(await alpha(-4, 350), 0, "live brush paint is clipped");
      assert.ok(await alpha(3, 350), "live brush paint is visible inside");
      await page.screenshot({ path: `${artifacts}-brush-paint.png` });
      await page.mouse.up();
    },
  );
  assert.ok(brush.length);
  bounded(brush);
  const erased = await saved("brush erases the overlapping footprint", () =>
    page.mouse.click(
      image.left - 8 * image.scale,
      image.top + 350 * image.scale,
      { button: "right" },
    ),
  );
  assert.equal(erased.length, 0);
  await move(-100, 350);
  assert.equal(await cursor(), "not-allowed");
  assert.equal(
    await page.getByTestId("brush-cursor").evaluate((el) => el.hidden),
    true,
  );

  // Zoom around the center while some letterboxing remains, then test the new edge.
  await move(500, 350);
  await zoomAt(500, 350, -150);
  assert.ok(image.scale > 0.8, "view is zoomed");
  await move(-8, 350);
  assert.equal(await cursor(), "none");
  const zoomed = await saved(
    "zoomed brush respects the transformed image edge",
    () =>
      page.mouse.click(
        image.left - 8 * image.scale,
        image.top + 350 * image.scale,
      ),
  );
  bounded(zoomed);
  await move(-100, 350);
  await page.keyboard.press("p");
  assert.equal(await cursor(), "not-allowed");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(100);
  image = await bounds();
  await move(-40, 350);
  assert.equal(
    await cursor(),
    "not-allowed",
    "resizing updates the point boundary",
  );
  await page.keyboard.press("r");
  await move(-8, 350);
  assert.equal(await cursor(), "none", "resizing updates brush clipping");
  await page.screenshot({ path: `${artifacts}-after.png` });
  await writeFile(
    `${artifacts}-after.aria.txt`,
    await page.locator("body").ariaSnapshot(),
  );
  const me = await page.request.get(`${state.webUrl}/me`);
  assert.ok(me.ok());
  await writeFile(
    `${artifacts}-me.json`,
    JSON.stringify(await me.json(), null, 2),
  );
  await writeFile(
    `${artifacts}-checks.json`,
    JSON.stringify(
      { feature: "features/annotate-submit.md", ok: true, results },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ ok: true, checks: results.map((r) => r.label) }),
  );
}
