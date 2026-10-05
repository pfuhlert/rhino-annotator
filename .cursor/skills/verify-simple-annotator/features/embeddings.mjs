import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

const aiIdle = (page) =>
  page.getByTestId("ai-status").evaluate((el) => el.dataset.worker === "ready" && el.dataset.pending === "0");

const artifacts = ".cursor/skills/verify-simple-annotator/artifacts/embeddings";

export default async function (page, state) {
  assert.notEqual(new URL(state.webUrl).port, "3000");
  const json = async (path) => {
    const response = await page.request.get(`${state.webUrl}${path}`);
    assert.ok(response.ok());
    return response.json();
  };
  const until = async (read, accept) => {
    for (let i = 0; i < 150; i++) {
      const value = await read();
      if (accept(value)) return value;
      await page.waitForTimeout(200);
    }
    throw new Error("Timed out waiting for expected state");
  };
  const cache = () => JSON.parse(execFileSync("sqlite3", ["-cmd", ".timeout 5000", "-json", state.sqlite,
    "SELECT id, status, created, length(data) AS bytes, input FROM ai_embeddings WHERE json_extract(input, '$.item_id') = 'tem' ORDER BY id;",
  ], { encoding: "utf8" }) || "[]");
  const select = async (id, option) => {
    await page.getByTestId(id).click();
    await page.getByTestId(option).click();
    await page.getByTestId(option).waitFor({ state: "hidden" });
  };
  const canvas = page.getByTestId("patch-canvas");
  const ready = () => page.waitForFunction(() => {
    const img = document.querySelector('[data-testid="patch-canvas"] [data-image-plane]');
    return img?.dataset.loaded === 'true' && img.dataset.width === '1024' && img.dataset.height === '1024';
  });
  const move = async (x, y) => {
    const p = await canvas.evaluate((el, point) => {
      const img = el.querySelector("[data-image-plane]"), r = img.getBoundingClientRect();
      const scale = Math.min(r.width / Number(img.dataset.width), r.height / Number(img.dataset.height));
      return [r.left + (r.width - Number(img.dataset.width) * scale) / 2 + point[0] * scale,
        r.top + (r.height - Number(img.dataset.height) * scale) / 2 + point[1] * scale];
    }, [x, y]);
    await page.mouse.move(...p, { steps: 6 });
  };
  const posted = () => page.waitForResponse((r) => /\/patches\/\d+\/ai$/.test(r.url()) && r.request().method() === "POST");
  const complete = async (task) => {
    const status = await until(() => json(`/patches/ai?patch_id=${task.patch_id}`),
      (s) => s.elements.some((el) => el.id === `ai-${task.id}`) ||
        s.tasks.some((t) => t.id === task.id && t.status === "failed"));
    assert.ok(!status.tasks.some((t) => t.id === task.id && t.status === "failed"), JSON.stringify(status.tasks));
    const polygon = status.elements.find((el) => el.id === `ai-${task.id}`);
    assert.equal(polygon.type, "polygon");
    assert.equal(polygon.jobId, task.job_id);
    return polygon;
  };

  await page.goto("/annotate");
  await canvas.waitFor();
  await ready();
  assert.equal((await json("/patches/current")).nm_per_px, null);
  await page.getByTestId("scale-bar").waitFor({ state: "hidden" });
  await page.getByTestId("tab-images").click();
  await page.getByTestId("folder-fixtures").click();
  const started = Date.now();
  await page.getByTestId("folder-elmi").click();
  await ready();
  const loadMs = Date.now() - started;
  await page.getByTestId("sidebar-trigger").click();
  const initial = await json("/patches/current");
  assert.equal(initial.nm_per_px, 5);
  await page.getByTestId("scale-bar").waitFor();
  const preparing = cache();
  assert.equal(preparing.length, 5);
  assert.equal(initial.elements.length, 0);
  const jobs = await json("/jobs");

  await select("job-switcher", "job-Podocyte");
  await page.keyboard.press("l");
  const saved = page.waitForResponse((r) => /\/annotations$/.test(r.url()) && r.request().method() === "PATCH");
  await move(150, 250);
  await page.mouse.down();
  for (const p of [[210, 250], [210, 320], [150, 320], [150, 250]]) await move(...p);
  await page.mouse.up();
  assert.ok((await saved).ok());
  const manual = (await json("/patches/current")).elements;
  assert.equal(manual.length, 1);
  const prepared = await until(cache, (rows) => rows.every((r) => r.status === "ready" && r.bytes > 0));
  assert.equal(prepared.length, 5);
  assert.ok(prepared.some((r) => {
    const region = JSON.parse(r.input);
    return region.width === 700 && region.height === 700;
  }));

  await page.keyboard.press("a");
  await move(475, 758);
  await page.mouse.down();
  await move(530, 803);
  const boxResponse = posted();
  await page.mouse.up();
  const boxTask = await (await boxResponse).json();
  assert.deepEqual(boxTask.box, [475, 758, 530, 803]);
  const boxPolygon = await complete(boxTask);
  for (const ring of [boxPolygon.points, ...(boxPolygon.holes ?? [])])
    assert.ok(ring.every(([x, y]) => x >= 475 && x < 530 && y >= 758 && y < 803));
  await until(() => aiIdle(page), Boolean);
  await page.screenshot({ path: `${artifacts}-box.png`, fullPage: true });

  await page.getByTestId("next").click();
  await until(() => json("/patches/current"), (p) => p.id !== initial.id);
  await ready();
  const second = await json("/patches/current");
  await select("job-switcher", "job-Nucleus");
  await page.keyboard.press("p");
  await move(500, 780);
  const pointResponse = posted();
  await page.mouse.down();
  await page.mouse.up();
  const pointTask = await (await pointResponse).json();
  assert.equal(pointTask.job_id, jobs.find((j) => j.name === "Nucleus").id);
  assert.ok(!pointTask.box);
  const pointPolygon = await complete(pointTask);
  await until(() => aiIdle(page), Boolean);
  await page.keyboard.press("Control+z");
  await until(() => json("/patches/current"), (p) => p.elements.length === 0);
  await page.keyboard.press("Control+Shift+z");
  await until(() => json("/patches/current"), (p) => p.elements.length === 1);
  await page.reload();
  await ready();
  assert.deepEqual((await json("/patches/current")).elements, [pointPolygon]);
  await page.screenshot({ path: `${artifacts}-point.png`, fullPage: true });
  await page.getByTestId("prev").click();
  await until(() => json("/patches/current"), (p) => p.id === initial.id);
  await ready();
  assert.deepEqual((await json("/patches/current")).elements, [...manual, boxPolygon]);
  assert.deepEqual(cache(), prepared, "prompts and repeat visits reuse all persisted embeddings");
  const evidence = {
    feature: "features/ai-annotation.md", loadMs, preparing, prepared,
    patches: [initial.id, second.id], manual, boxTask, pointTask, boxPolygon, pointPolygon,
  };
  await writeFile(`${artifacts}-checks.json`, JSON.stringify(evidence, null, 2));
  await writeFile(`${artifacts}.aria.txt`, await page.locator("body").ariaSnapshot());
  await writeFile(`${artifacts}-me.json`, JSON.stringify(await json("/me"), null, 2));
  assert.ok((await page.request.patch(`${state.webUrl}/me`, {
    data: { last_folder_id: "placeholder" },
  })).ok());
  await page.reload();
  await ready();
  assert.equal((await json("/patches/current")).nm_per_px, null);
  await page.getByTestId("scale-bar").waitFor({ state: "hidden" });
  await page.screenshot({ path: `${artifacts}-uncalibrated.png`, fullPage: true });
  await writeFile(`${artifacts}-uncalibrated-me.json`, JSON.stringify(await json("/me"), null, 2));
  console.log(JSON.stringify({ ok: true, loadMs, tiles: prepared.length, artifacts }));
}
