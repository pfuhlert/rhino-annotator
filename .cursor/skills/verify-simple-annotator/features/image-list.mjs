import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

const artifacts = ".cursor/skills/verify-simple-annotator/artifacts/image-list";

export default async function (page, state) {
  const requests = [];
  page.on("request", (r) => requests.push(new URL(r.url()).pathname));
  const json = async (path) =>
    (await page.request.get(`${state.webUrl}${path}`)).json();
  const at = async () => {
    const p = await json("/patches/current");
    return [p.item_id, p.slide ? p.slide.current : 0];
  };
  async function nav(action, path) {
    results.waitingFor = path;
    const response = page.waitForResponse(
      (r) => new URL(r.url()).pathname === path,
    );
    await action();
    assert.ok((await response).ok(), `${path} succeeds`);
    // Keys pressed while the page is still busy are ignored, so wait until Next is enabled again.
    await page.waitForFunction(
      () =>
        document.querySelector("[data-image-plane]")?.dataset.loaded ===
          "true" && !document.querySelector('[data-testid="next"]')?.disabled,
    );
    return at();
  }
  const next = () => nav(() => page.keyboard.press("n"), "/patches/next");
  const prev = () => nav(() => page.keyboard.press("b"), "/patches/prev");
  const shot = (name) => page.screenshot({ path: `${artifacts}-${name}.png` });
  const results = {};
  try {
    await run();
  } finally {
    await shot("last");
    await writeFile(
      `${artifacts}-results.json`,
      JSON.stringify(results, null, 2),
    );
  }
  return results;

  async function run() {
    await page.goto("/annotate");
    await page.getByTestId("patch-canvas").waitFor();
    if (!(await page.getByTestId("tab-images").isVisible()))
      await page.getByTestId("sidebar-trigger").click();
    await page.getByTestId("sidebar-pin").click();
    assert.equal(
      await page.getByTestId("tab-history").count(),
      0,
      "no History tab",
    );
    await page.getByTestId("tab-images").click();
    if (await page.getByTestId("folder-fixtures").isVisible())
      await page.getByTestId("folder-fixtures").click();
    await nav(
      () => page.getByTestId("folder-histo").click(),
      "/patches/current",
    );
    await page.getByTestId("image-row-slide").waitFor();
    const nested = page
      .getByTestId("folder-histo")
      .locator("xpath=ancestor::div[contains(@class,'sticky')][1]/..");
    assert.equal(
      await nested.getByTestId("image-list").count(),
      1,
      "images nest under the folder",
    );

    results.opened = await at();
    assert.deepEqual(results.opened, ["slide", 0]);
    const expanded = (group) =>
      page.getByTestId(`image-group-${group}`).getAttribute("aria-expanded");
    assert.equal(await expanded("case-2"), "true", "current case expanded");
    assert.equal(await expanded("case-10"), "false", "other case collapsed");
    assert.equal(
      await page.getByTestId("image-row-slide").getAttribute("aria-current"),
      "true",
    );
    results.rowText = await page.getByTestId("image-row-slide").innerText();
    assert.match(
      results.rowText,
      /Synthetic H&E\.svs[\s\S]*HE[\s\S]*40×[\s\S]*1\/3/,
    );
    await shot("opened");

    const before = requests.filter((p) => p === "/images").length;
    results.walk = [await next(), await next()];
    assert.deepEqual(results.walk, [
      ["slide", 1],
      ["slide", 2],
    ]);
    assert.match(await page.getByTestId("image-row-slide").innerText(), /3\/3/);
    results.imagesFetchesWithinSlide =
      requests.filter((p) => p === "/images").length - before;
    assert.equal(
      results.imagesFetchesWithinSlide,
      0,
      "no list refetch between regions",
    );
    results.crossImage = await next();
    assert.deepEqual(results.crossImage, ["slide-pas", 0]);
    results.prevAcross = await prev();
    assert.deepEqual(
      results.prevAcross,
      ["slide", 2],
      "Prev lands on the last region",
    );

    async function toggleStain(name) {
      const saved = page.waitForResponse(
        (r) => new URL(r.url()).pathname === "/me",
      );
      await page.getByTestId(`stain-option-${name}`).click();
      assert.ok((await saved).ok(), `${name} filter saved`);
    }
    await page.getByTestId("stain-filter").click();
    await toggleStain("PAS");
    await toggleStain("HE");
    results.meWithTwoStains = (await json("/me")).stain_filter;
    assert.deepEqual(
      results.meWithTwoStains,
      ["PAS", "HE"],
      "several stains at once",
    );
    await page.getByTestId("image-row-slide").waitFor();
    await shot("stain-menu");
    await toggleStain("HE");
    await page.keyboard.press("Escape");
    assert.equal(
      await page.getByRole("listbox").count(),
      0,
      "Escape closes the menu",
    );
    assert.equal(await page.getByTestId("stain-filter").innerText(), "PAS");
    assert.equal(
      await page.getByTestId("image-row-slide").count(),
      0,
      "HE row hidden",
    );
    results.meAfterFilter = (await json("/me")).stain_filter;
    assert.deepEqual(results.meAfterFilter, ["PAS"]);
    await shot("filtered");
    results.nextFiltered = await next();
    assert.deepEqual(
      results.nextFiltered,
      ["slide-pas", 0],
      "Next skips the HE slide",
    );

    await page.getByTestId("image-group-case-10").click();
    results.clicked = await nav(
      () => page.getByTestId("image-row-slide-b").click(),
      "/patches/open",
    );
    assert.deepEqual(results.clicked, ["slide-b", 0]);
    assert.match(
      await page.getByTestId("image-row-slide-b").innerText(),
      /20×/,
    );
    results.wrap = [await next(), await next(), await next()];
    assert.deepEqual(results.wrap, [
      ["slide-b", 1],
      ["slide-b", 2],
      ["slide-pas", 0],
    ]);
    await shot("wrapped");

    await page.setViewportSize({ width: 1280, height: 330 });
    const panel = page.getByRole("tabpanel");
    const header = page.getByTestId("folder-back").locator("xpath=..");
    const pinned = page
      .getByTestId("folder-histo")
      .locator("xpath=ancestor::div[contains(@class,'sticky')][1]");
    const pinnedState = async (scrollTop) => {
      await panel.evaluate((el, top) => (el.scrollTop = top), scrollTop);
      await page.waitForTimeout(200);
      const [h, p] = [await header.boundingBox(), await pinned.boundingBox()];
      return {
        pixels: [await header.screenshot(), await pinned.screenshot()],
        pitch: p.y - h.y,
      };
    };
    const rest = await pinnedState(0);
    const scrolled = await pinnedState(1e6);
    await shot("pinned-scrolled");
    results.pinned = {
      scrollTop: await panel.evaluate((el) => el.scrollTop),
      pitchScrolled: scrolled.pitch,
      headerIdentical: Buffer.compare(rest.pixels[0], scrolled.pixels[0]) === 0,
      blockIdentical: Buffer.compare(rest.pixels[1], scrolled.pixels[1]) === 0,
    };
    assert.ok(results.pinned.scrollTop > 0, "the list scrolls");
    assert.equal(
      results.pinned.pitchScrolled,
      34,
      "pinned folder keeps the row pitch",
    );
    assert.ok(
      results.pinned.headerIdentical && results.pinned.blockIdentical,
      "pinned is opaque",
    );
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.reload();
    await page.getByTestId("patch-canvas").waitFor();
    if (!(await page.getByTestId("tab-images").isVisible()))
      await page.getByTestId("sidebar-trigger").click();
    await page.getByTestId("tab-images").click();
    await page.getByTestId("stain-filter").filter({ hasText: "PAS" }).waitFor();
    results.filterAfterReload = true;

    if (await page.getByTestId("folder-fixtures").isVisible())
      await page.getByTestId("folder-fixtures").click();
    await nav(
      () => page.getByTestId("folder-elmi").click(),
      "/patches/current",
    );
    await page.getByTestId("image-row-tem").waitFor();
    results.meAfterFolderSwitch = (await json("/me")).stain_filter;
    assert.deepEqual(results.meAfterFolderSwitch, []);
    assert.equal(
      await page.getByTestId("stain-filter").count(),
      0,
      "no stain filter without stains",
    );
    await shot("elmi");

    results.visitsRequests = requests.filter((p) =>
      p.startsWith("/patches/visits"),
    ).length;
    assert.equal(results.visitsRequests, 0);
    delete results.waitingFor;
  }
}
