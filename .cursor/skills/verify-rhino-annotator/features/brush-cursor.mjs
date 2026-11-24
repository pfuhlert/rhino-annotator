import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

const artifacts = ".cursor/skills/verify-rhino-annotator/artifacts";

export default async function (page, state) {
  // Give the placeholder image calibration so scale-bar mounting is exercised too.
  await page.route("**/patches/current", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), nm_per_px: 2 },
    });
  });
  await page.goto("/annotate");
  await page.getByTestId("patch-canvas").waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="patch-canvas"] [data-image-plane]')
        ?.dataset.loaded === 'true',
  );
  await page.getByTestId("scale-bar").waitFor();
  await page.keyboard.press("r");
  const root = page.getByTestId("patch-canvas");
  const box = await root.boundingBox();
  let x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await root.evaluate((el) => {
    const canvas = el.querySelector('[data-testid="patch-marks"]');
    const ctx = canvas.getContext("2d");
    const clear = ctx.clearRect.bind(ctx);
    const measure = el.getBoundingClientRect.bind(el);
    el.cursorHost = el.querySelector('[data-testid="brush-cursor"]');
    el.cursorRing = el.cursorHost.querySelector("svg");
    el.boundsReads = 0;
    el.pointerMoves = 0;
    el.cursorTransforms = 0;
    el.cursorVisibilityChanges = 0;
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.target === el.cursorRing && record.attributeName === "style")
          el.cursorTransforms++;
        if (
          record.target === el.cursorHost &&
          record.attributeName === "hidden"
        )
          el.cursorVisibilityChanges++;
      }
    }).observe(el.cursorHost, {
      attributes: true,
      subtree: true,
      attributeFilter: ["style", "hidden"],
    });
    el.getBoundingClientRect = () => {
      el.boundsReads++;
      return measure();
    };
    el.addEventListener("pointermove", () => el.pointerMoves++);
    el.redrawCount = 0;
    ctx.clearRect = (...args) => {
      el.redrawCount++;
      return clear(...args);
    };
  });

  const read = () =>
    root.evaluate((el) => {
      const css = getComputedStyle(el).cursor;
      const outline = el.querySelector('[data-testid="brush-cursor"]');
      const ring = outline?.querySelector("svg");
      const url = css.match(/url\("([^"]+)"\)/)?.[1];
      const svg = url?.startsWith("data:")
        ? new DOMParser().parseFromString(
            decodeURIComponent(url.split(",")[1]),
            "image/svg+xml",
          )
        : ring;
      const img = el.querySelector(":scope > [data-image-plane]");
      const rect = img.getBoundingClientRect();
      const ringRect = ring?.getBoundingClientRect();
      return {
        css,
        cursorStyle: el.style.cursor,
        cursorRetained: outline === el.cursorHost && ring === el.cursorRing,
        radius: Number(svg?.querySelector("circle")?.getAttribute("r")),
        scale: Math.min(
          rect.width / Number(img.dataset.width),
          rect.height / Number(img.dataset.height),
        ),
        transform: img.style.transform,
        zoom: new DOMMatrix(getComputedStyle(img).transform).a,
        outline: outline ? !outline.hidden : false,
        center: ringRect
          ? [ringRect.x + ringRect.width / 2, ringRect.y + ringRect.height / 2]
          : null,
        redraws: el.redrawCount,
        boundsReads: el.boundsReads,
        pointerMoves: el.pointerMoves,
        cursorTransforms: el.cursorTransforms,
        cursorVisibilityChanges: el.cursorVisibilityChanges,
      };
    });
  const near = (a, b) => assert.ok(Math.abs(a - b) < 0.1, `${a} != ${b}`);
  const results = [];
  async function check(label, oversized = false, radius = 16) {
    const current = await read();
    assert.ok(
      current.cursorRetained,
      "React updates must preserve the cursor host and ring",
    );
    assert.equal(current.outline, oversized, label);
    assert.ok(
      oversized ? current.css === "none" : current.css.startsWith('url("data:'),
      label,
    );
    near(current.radius, radius);
    if (oversized) {
      near(current.center[0], x);
      near(current.center[1], y);
    }
    results.push({ label, ...current });
    return current;
  }
  async function pan(...keys) {
    for (const key of keys) await page.keyboard.press(key);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  }
  async function wheel(dx, dy, modifier = null) {
    const before = (await read()).redraws;
    if (modifier) await page.keyboard.down(modifier);
    await page.mouse.wheel(dx, dy);
    if (modifier) await page.keyboard.up(modifier);
    await page.waitForFunction(
      (count) =>
        document.querySelector('[data-testid="patch-canvas"]').redrawCount >
        count,
      before,
    );
  }
  async function moveWithoutRedraw(oversized = false, radius = 16) {
    const before = await read();
    x += 24;
    await page.mouse.move(x, y, { steps: 12 });
    const after = await check("pointer movement", oversized, radius);
    assert.equal(
      after.redraws,
      before.redraws,
      "cursor motion must not repaint annotations",
    );
    const moves = after.pointerMoves - before.pointerMoves;
    assert.ok(moves > 0);
    assert.equal(
      after.cursorTransforms - before.cursorTransforms,
      oversized ? moves : 0,
      "at most one outline transform per pointer movement",
    );
    assert.equal(
      after.cursorVisibilityChanges,
      before.cursorVisibilityChanges,
      "idle motion must not toggle outline visibility",
    );
    assert.equal(
      after.boundsReads,
      before.boundsReads,
      "cursor motion must use the cached origin",
    );
  }

  async function leaveAndReenter(oversized = false, radius = 16) {
    const before = await read();
    await page.mouse.move(-10, -10);
    const after = await read();
    assert.equal(after.outline, false, "hide on leave");
    assert.equal(after.cursorStyle, "", "leave must clear the native cursor");
    assert.equal(
      after.redraws,
      before.redraws,
      "brush leave must not repaint annotations",
    );
    assert.equal(
      after.boundsReads,
      before.boundsReads,
      "brush leave must not read bounds",
    );
    await page.mouse.move(x, y);
    await check("leave and reenter", oversized, radius);
  }

  async function paintAndErase(label) {
    const current = await read();
    assert.ok(
      current.zoom > 1,
      "paint and erase must run with the view still zoomed and panned",
    );
    async function alpha(offset = 0) {
      return root.evaluate(
        (el, { x, y }) => {
          const canvas = el.querySelector('[data-testid="patch-marks"]');
          const rect = canvas.getBoundingClientRect();
          return canvas
            .getContext("2d")
            .getImageData(
              Math.floor(((x - rect.left) * canvas.width) / rect.width),
              Math.floor(((y - rect.top) * canvas.height) / rect.height),
              1,
              1,
            ).data[3];
        },
        { x: x + offset, y },
      );
    }
    await page.mouse.click(x, y);
    assert.ok((await alpha()) > 0, "paint at the cursor center");
    assert.ok(
      (await alpha(current.radius * 0.7)) > 0,
      "paint fills the displayed radius",
    );
    assert.equal(
      await alpha(current.radius * 1.3),
      0,
      "paint stays within the displayed radius",
    );
    await page.mouse.click(x, y, { button: "right" });
    assert.equal(await alpha(), 0, "erase at the cursor center");
    assert.equal(
      await alpha(current.radius * 0.7),
      0,
      "erase the displayed radius",
    );
    assert.equal((await read()).transform, current.transform);
    results.push({
      label,
      zoom: current.zoom,
      radius: current.radius,
      paintAndErase: true,
    });
  }

  await check("native brush");
  const beforeResizeWheel = (await read()).transform;
  await wheel(0, -100, "Shift");
  await check("Shift wheel up grows brush", false, 18);
  await wheel(0, 100, "Shift");
  await check("Shift wheel down shrinks brush");
  await wheel(-100, 0, "Shift");
  await check("Shift horizontal wheel grows brush", false, 18);
  await wheel(100, 0, "Shift");
  await check("Shift horizontal wheel shrinks brush");
  assert.equal((await read()).transform, beforeResizeWheel);
  for (let i = 0; i < 7; i++) await page.keyboard.press("[");
  await root.dispatchEvent("wheel", { clientX: x, clientY: y, deltaY: 100, shiftKey: true });
  await check("Shift wheel clamps at minimum", false, 10);
  for (let i = 0; i < 3; i++) await page.keyboard.press("]");
  await moveWithoutRedraw();
  await leaveAndReenter();
  await wheel(0, -400, "Control");
  await check("native zoom");
  const beforeZoomedResize = (await read()).transform;
  await wheel(0, -100, "Shift");
  await check("Shift wheel resizes while zoomed", false, 18);
  assert.equal((await read()).transform, beforeZoomedResize, "resizing must not pan or zoom");
  await wheel(0, 100, "Shift");
  const beforePan = (await read()).transform;
  await pan("ArrowRight", "ArrowDown");
  assert.notEqual((await read()).transform, beforePan);
  await check("native pan");
  await moveWithoutRedraw();
  await paintAndErase("native paint and erase while zoomed and panned");

  for (let i = 0; i < 32; i++) await page.keyboard.press("]");
  await check("large brush", true, 80);
  await root.dispatchEvent("wheel", { clientX: x, clientY: y, deltaY: -100, shiftKey: true });
  await check("Shift wheel clamps at maximum", true, 80);
  await moveWithoutRedraw(true, 80);
  await pan("ArrowRight", "ArrowDown");
  await check("large brush pan", true, 80);
  await paintAndErase("large brush paint and erase while zoomed and panned");
  const button = await page.getByTestId("next").boundingBox();
  await page.mouse.move(
    button.x + button.width / 2,
    button.y + button.height / 2 - (await read()).radius,
  );
  const toolbarAboveOutline = await root.evaluate((el) => {
    const outline = el.querySelector('[data-testid="brush-cursor"]');
    const button = document.querySelector('[data-testid="next"]');
    const rect = button.getBoundingClientRect();
    const previous = outline.style.pointerEvents;
    try {
      outline.style.pointerEvents = "auto";
      const stack = document.elementsFromPoint(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
      );
      return (
        stack.indexOf(button) >= 0 &&
        stack.indexOf(button) < stack.indexOf(outline)
      );
    } finally {
      outline.style.pointerEvents = previous;
    }
  });
  assert.ok(
    toolbarAboveOutline,
    "toolbar must be above the large brush outline",
  );
  results.push({ label: "toolbar above outline", toolbarAboveOutline });
  await page.screenshot({ path: artifacts + "/brush-cursor-toolbar.png" });
  await page.mouse.move(x, y);
  await wheel(0, -500, "Control");
  await check("large brush zoom", true, 80);
  await pan(...Array(200).fill("ArrowDown"));
  await check("clamped pan", true, 80);
  await moveWithoutRedraw(true, 80);

  // A wheel event can have fresher coordinates than the last pointermove.
  x += 18;
  await root.dispatchEvent("wheel", { clientX: x, clientY: y, deltaY: -50 });
  // Wheel zooming applies on the next animation frame.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await check("wheel coordinates", true, 80);
  await page.mouse.move(x, y);
  const beforeResize = (await read()).redraws;
  await page.setViewportSize({ width: 1360, height: 800 });
  await page.waitForFunction(
    (count) =>
      document.querySelector('[data-testid="patch-canvas"]').redrawCount >
      count,
    beforeResize,
  );
  await check("resize", true, 80);

  const beforeOffset = await read();
  await root.evaluate((el) => {
    el.style.left = "40px";
  });
  await page.waitForFunction(
    (count) =>
      document.querySelector('[data-testid="patch-canvas"]').redrawCount >
      count,
    beforeOffset.redraws,
  );
  const offset = await check("origin change without scale change", true, 80);
  near(offset.radius, beforeOffset.radius);

  await root.evaluate((el) =>
    Object.assign(el.style, { left: "700px", width: "200px", right: "auto" }),
  );
  await page.getByTestId("scale-bar").waitFor({ state: "hidden" });
  await check("scale bar unmount", true, 80);
  await root.evaluate((el) => {
    for (const key of ["left", "width", "right"]) el.style.removeProperty(key);
  });
  await page.getByTestId("scale-bar").waitFor();
  await check("scale bar remount", true, 80);
  await moveWithoutRedraw(true, 80);
  await leaveAndReenter(true, 80);
  for (const [key, shape] of [
    ["p", 'r="1.5"'],
    ["l", "M27 18"],
  ]) {
    await page.keyboard.press(key);
    const current = await read();
    assert.ok(current.css.startsWith('url("data:image/svg+xml,'), current.css);
    assert.ok(current.css.includes(encodeURIComponent(shape)), current.css);
    assert.equal(current.outline, false);
  }
  await page.keyboard.press("r");
  await check("switch back", true, 80);
  await page.screenshot({ path: `${artifacts}/brush-cursor-large.png` });
  await wheel(0, 5000, "Control");
  await check("zoom out", true, 80);

  for (let i = 0; i < 32; i++) await page.keyboard.press("[");
  await check("restore brush size");
  await page.mouse.click(x, y);
  await page.keyboard.press("l");
  assert.equal(
    (await read()).css,
    "grab",
    "switching tools refreshes hover without moving the pointer",
  );
  await page.mouse.move(-10, -10);
  const unhovered = await root.evaluate((el) =>
    el.querySelector('[data-testid="patch-marks"]').toDataURL(),
  );
  await page.mouse.move(x + 1, y);
  assert.equal((await read()).css, "grab");
  assert.notEqual(
    await root.evaluate((el) => el.querySelector('[data-testid="patch-marks"]').toDataURL()),
    unhovered,
  );
  await page.mouse.move(-10, -10);
  assert.equal(
    await root.evaluate((el) => el.querySelector('[data-testid="patch-marks"]').toDataURL()),
    unhovered,
    "polygon leave must clear the hover highlight",
  );
  assert.equal((await read()).cursorStyle, "");
  results.push({ label: "polygon hover clears on leave" });
  await page.keyboard.press("r");
  await page.mouse.move(x, y);
  await page.mouse.click(x, y, { button: "right" });
  await page.screenshot({ path: `${artifacts}/brush-cursor-after.png` });
  await writeFile(
    `${artifacts}/brush-cursor-after.aria.txt`,
    await page.locator("body").ariaSnapshot(),
  );
  const me = await page.request.get(`${state.webUrl}/me`);
  assert.ok(me.ok());
  await writeFile(
    `${artifacts}/brush-cursor-me.json`,
    JSON.stringify(await me.json(), null, 2),
  );
  await writeFile(
    `${artifacts}/brush-cursor-checks.json`,
    JSON.stringify(
      {
        feature: "features/annotate-submit.md",
        ok: true,
        results,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ ok: true, checks: results.map(({ label }) => label) }),
  );
}
