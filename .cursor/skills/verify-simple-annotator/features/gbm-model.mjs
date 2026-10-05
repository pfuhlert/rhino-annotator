import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

const artifacts = ".cursor/skills/verify-simple-annotator/artifacts/gbm-model";
const GBM_MODEL = "gbm-fpw-clahe-vit_l";
const DEFAULT_MODEL = "microsam-em-vit_l-1.2";
// Membrane points on the R1174-26-1 fixture, in image pixels.
const CLICKS = [[850, 1634], [1321, 390]];

export default async function (page, state) {
  assert.notEqual(new URL(state.webUrl).port, "3000");
  await mkdir(artifacts, { recursive: true });
  const json = async (path) => {
    const response = await page.request.get(`${state.webUrl}${path}`);
    assert.ok(response.ok());
    return response.json();
  };
  const sql = (query) => JSON.parse(execFileSync("sqlite3", ["-cmd", ".timeout 5000", "-json", state.sqlite, query],
    { encoding: "utf8" }) || "[]");
  const until = async (read, accept) => {
    for (let i = 0; i < 300; i++) {
      const value = await read();
      if (accept(value)) return value;
      await page.waitForTimeout(200);
    }
    throw new Error("Timed out waiting for expected state");
  };
  const select = async (id, option) => {
    await page.getByTestId(id).click();
    await page.getByTestId(option).click();
    await page.getByTestId(option).waitFor({ state: "hidden" });
  };
  const canvas = page.getByTestId("patch-canvas");
  const click = async ([x, y]) => {
    const p = await canvas.evaluate((el, point) => {
      const img = el.querySelector("[data-image-plane]"), r = img.getBoundingClientRect();
      const scale = Math.min(r.width / Number(img.dataset.width), r.height / Number(img.dataset.height));
      return [r.left + (r.width - Number(img.dataset.width) * scale) / 2 + point[0] * scale,
        r.top + (r.height - Number(img.dataset.height) * scale) / 2 + point[1] * scale];
    }, [x, y]);
    const posted = page.waitForResponse((r) => /\/patches\/\d+\/ai$/.test(r.url()) && r.request().method() === "POST");
    await page.mouse.click(...p);
    return (await posted).json();
  };
  const complete = async (task) => {
    const status = await until(() => json(`/patches/ai?patch_id=${task.patch_id}`),
      (s) => s.elements.some((el) => el.id === `ai-${task.id}`) ||
        s.tasks.some((t) => t.id === task.id && t.status === "failed"));
    assert.ok(!status.tasks.some((t) => t.id === task.id && t.status === "failed"), JSON.stringify(status.tasks));
    return status.elements.find((el) => el.id === `ai-${task.id}`);
  };
  const taskModel = (id) => JSON.parse(sql(`SELECT input FROM ai_tasks WHERE id = '${id}';`)[0].input).model;
  const embeddings = () => sql("SELECT status, json_extract(input, '$.model') AS model, " +
    "json_extract(input, '$.width') AS width, json_extract(input, '$.height') AS height " +
    "FROM ai_embeddings WHERE json_extract(input, '$.item_id') = 'tem';");

  await page.goto("/annotate");
  await canvas.waitFor();
  if ((await json("/patches/current")).nm_per_px === null) {
    await page.getByTestId("tab-images").click();
    await page.getByTestId("folder-fixtures").click();
    await page.getByTestId("folder-elmi").click();
    await page.getByTestId("sidebar-trigger").click();
  }
  await page.waitForFunction(() => document.querySelector('[data-testid="patch-canvas"] [data-image-plane]')?.dataset.width === '2048');
  const current = (await json("/me")).last_job_id;
  const job = (await json("/jobs")).find((j) => j.id === current);
  const opened = embeddings().filter((row) => row.model === GBM_MODEL);
  assert.equal(opened.length, job.name === "GBM" ? 1 : 0, "opening prepares GBM only while GBM is selected");

  await select("job-switcher", "job-GBM");
  await select("tool-switcher", "tool-point");
  const gbm = [];
  for (const point of CLICKS) {
    const task = await click(point);
    assert.equal(taskModel(task.id), GBM_MODEL);
    gbm.push(await complete(task));
  }
  const gbmRows = embeddings().filter((row) => row.model === GBM_MODEL);
  assert.deepEqual(gbmRows, [{ status: "ready", model: GBM_MODEL, width: 2048, height: 2048 }],
    "GBM uses one whole-image embedding");
  await page.screenshot({ path: `${artifacts}/gbm.png` });

  await select("job-switcher", "job-Mitochondria");
  await select("tool-switcher", "tool-point");
  const mito = await click(CLICKS[0]);
  assert.equal(taskModel(mito.id), DEFAULT_MODEL);
  await complete(mito);
  assert.ok(embeddings().some((row) => row.model === DEFAULT_MODEL && row.status === "ready"));

  await writeFile(`${artifacts}/polygons.json`, JSON.stringify({ gbm, embeddings: embeddings() }, null, 2));
  return { gbmPolygons: gbm.length, gbmVertices: gbm.map((p) => p.points.length), embeddings: embeddings() };
}
