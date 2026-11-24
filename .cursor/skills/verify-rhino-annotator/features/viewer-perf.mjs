import { writeFile, mkdir } from "node:fs/promises";

// Scripted zoom + pan on the histology slide and the TEM image with 4x CPU throttling.
// Reports frame times, long tasks, tile requests, and how often the minimap view box moved.
const artifacts =
  ".cursor/skills/verify-rhino-annotator/artifacts/viewer-perf";
const label = process.env.PERF_LABEL || "run";
const STEPS = 90;

async function open(page, folder, item) {
  await page.goto("/annotate");
  await page.getByTestId("patch-canvas").waitFor();
  if (!(await page.getByTestId("tab-images").isVisible()))
    await page.getByTestId("sidebar-trigger").click();
  await page.getByTestId("tab-images").click();
  if (await page.getByTestId("folder-fixtures").isVisible())
    await page.getByTestId("folder-fixtures").click();
  // Folders remember being open, and clicking an open one collapses it.
  if (!(await page.getByTestId(`image-row-${item}`).isVisible()))
    await page.getByTestId(folder).click();
  await page.getByTestId(`image-row-${item}`).click();
  await page.waitForFunction(
    () =>
      document.querySelector("[data-image-plane]")?.dataset.loaded === "true",
  );
  if (await page.getByTestId("tab-images").isVisible())
    await page
      .getByTestId("sidebar-trigger")
      .click()
      .catch(() => {});
  await page.waitForTimeout(1500);
}

async function measure(page, cdp, name) {
  const box = await page.getByTestId("patch-canvas").boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  if (process.env.PERF_HIDE)
    await page.addStyleTag({
      content: `${process.env.PERF_HIDE} { display: none !important }`,
    });
  const tiles = [];
  const onRequest = (r) =>
    r.url().includes("/tiles/") && tiles.push(Date.now());
  page.on("request", onRequest);
  await page.evaluate(() => {
    const s = (window.__perf = {
      frames: [],
      long: 0,
      longCount: 0,
      moves: 0,
      lastMove: 0,
      draws: 0,
      drawArea: 0,
    });
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...a) {
      s.draws++;
      if (a.length >= 5) s.drawArea += a[a.length - 2] * a[a.length - 1];
      return drawImage.apply(this, a);
    };
    const tick = (t) => {
      s.frames.push(t);
      if (!s.stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        s.long += e.duration;
        s.longCount++;
      }
    }).observe({ type: "longtask" });
    const seen = new WeakSet();
    const watch = () => {
      const rect = document.querySelector('[data-testid="slide-map-view"]');
      if (rect && !seen.has(rect)) {
        seen.add(rect);
        new MutationObserver(() => {
          s.moves++;
          s.lastMove = performance.now();
        }).observe(rect, { attributes: true });
      }
    };
    new MutationObserver(watch).observe(document.body, {
      subtree: true,
      childList: true,
    });
    watch();
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  if (process.env.PERF_TRACE) {
    await page
      .context()
      .browser()
      .startTracing(page, {
        path: `${artifacts}/${label}-${name}.trace.json`,
        categories: [
          "devtools.timeline",
          "disabled-by-default-devtools.timeline",
          "blink",
          "cc",
          "gpu",
          "toplevel",
        ],
      });
  }
  if (process.env.PERF_PROFILE) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await cdp.send("Profiler.start");
  }
  const start = await page.evaluate(() => performance.now());
  await page.keyboard.down("Control");
  for (let i = 0; i < 25; i++) await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await page.mouse.down({ button: "middle" });
  let [px, py] = [cx, cy];
  for (let i = 0; i < STEPS; i++)
    await page.mouse.move((px += i < STEPS / 2 ? -40 : 40), (py += i % 30 < 15 ? -25 : 25));
  await page.mouse.up({ button: "middle" });
  // Snapshot the counters now so tiles that land after the interaction don't inflate per-frame cost.
  const { end, ...atEnd } = await page.evaluate(() => {
    const { draws, drawArea, long, longCount, moves } = window.__perf;
    return { end: performance.now(), draws, drawArea, long, longCount, moves };
  });
  const endWall = Date.now();
  await page.waitForTimeout(2500);
  if (process.env.PERF_TRACE) await page.context().browser().stopTracing();
  if (process.env.PERF_PROFILE) {
    const { profile } = await cdp.send("Profiler.stop");
    await writeFile(
      `${artifacts}/${label}-${name}.cpuprofile`,
      JSON.stringify(profile),
    );
  }
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  page.off("request", onRequest);
  const s = await page.evaluate(() => {
    window.__perf.stop = true;
    return window.__perf;
  });
  const frames = s.frames.filter((t) => t >= start && t <= end);
  const gaps = frames
    .slice(1)
    .map((t, i) => t - frames[i])
    .sort((a, b) => a - b);
  const q = (p) =>
    +gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))].toFixed(1);
  return {
    name,
    interactionMs: Math.round(end - start),
    frames: gaps.length,
    frameP50: q(0.5),
    frameP95: q(0.95),
    frameMax: q(1),
    slowFrames: gaps.filter((g) => g > 50).length,
    longTaskMs: Math.round(atEnd.long),
    longTasks: atEnd.longCount,
    drawsPerFrame: +(atEnd.draws / gaps.length).toFixed(1),
    drawnScreensPerFrame: +(
      atEnd.drawArea /
      gaps.length /
      (box.width * box.height)
    ).toFixed(2),
    tileRequests: tiles.length,
    tileRequestsAfterEnd: tiles.filter((t) => t > endWall).length,
    minimapMovesDuring: atEnd.moves,
    minimapSettleMs: s.lastMove ? Math.round(s.lastMove - end) : null,
  };
}

export default async function (page) {
  await mkdir(artifacts, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  // Tile responses come from the browser cache on a second pass; start every pass cold.
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  const results = [];
  for (const [folder, item] of [
    ["folder-histo", "slide"],
    ["folder-elmi", "tem"],
  ]) {
    await open(page, folder, item);
    results.push(await measure(page, cdp, item));
  }
  console.log(JSON.stringify(results, null, 2));
  await writeFile(
    `${artifacts}/${label}.json`,
    JSON.stringify(results, null, 2),
  );
}
