import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const artifacts = ".cursor/skills/verify-simple-annotator/artifacts/ai-box";

export default async function (page, state) {
  assert.notEqual(new URL(state.webUrl).port, "3000");
  const results = [];
  const root = page.getByTestId("patch-canvas");
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
  const ready = () => page.waitForFunction(() => {
    const img = document.querySelector('[data-testid="patch-canvas"] > img');
    return img?.complete && img.naturalWidth > 0;
  });
  async function select(id, option) {
    await page.getByTestId(id).click();
    await page.getByTestId(option).click();
    await page.getByTestId(option).waitFor({ state: "hidden" });
  }
  async function bounds() {
    return root.evaluate((el) => {
      const img = el.querySelector("img");
      const r = img.getBoundingClientRect();
      const scale = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
      return {
        left: r.left + (r.width - img.naturalWidth * scale) / 2,
        top: r.top + (r.height - img.naturalHeight * scale) / 2,
        scale,
      };
    });
  }
  async function move(x, y) {
    const s = await bounds();
    await page.mouse.move(s.left + x * s.scale, s.top + y * s.scale, { steps: 5 });
  }
  async function startBox(a, b) {
    await move(...a);
    await page.mouse.down();
    await move(...b);
  }
  const shot = (name) => page.screenshot({ path: `${artifacts}-${name}.png`, fullPage: true });
  const posts = [];
  page.on("request", (request) => {
    if (/\/patches\/\d+\/ai$/.test(request.url()) && request.method() === "POST")
      posts.push(request.postDataJSON());
  });

  await page.goto("/annotate");
  await root.waitFor();
  await ready();
  await page.getByTestId("tab-datasets").click();
  await page.getByTestId("folder-fixtures").click();
  await page.getByTestId("folder-elmi").click();
  await until(() => json("/patches/current"), (p) => p.folder_id === "elmi");
  await ready();
  await page.getByTestId("sidebar-trigger").click();
  await select("job-switcher", "job-Nucleus");
  const jobs = await json("/jobs");
  const job = jobs.find((j) => j.name === "Nucleus");
  await select("tool-switcher", "tool-ai-box");
  assert.equal(await page.getByTestId("tool-switcher").innerText(), "AI Box (A)");
  await move(250, 500);
  const cursor = await root.evaluate((el) => getComputedStyle(el).cursor);
  assert.match(cursor, /^url\("data:image\/svg\+xml,.*"\) 8 8, crosshair$/);
  assert.ok(cursor.includes(encodeURIComponent("M15 15h12v12H15z")), cursor);
  await page.keyboard.press("l");
  const lasso = await root.evaluate((el) => getComputedStyle(el).cursor);
  assert.ok(lasso.includes(encodeURIComponent("M27 18")), lasso);
  await page.keyboard.press("a");
  assert.equal(await root.evaluate((el) => getComputedStyle(el).cursor), cursor);
  results.push({ check: "global tool, menu, shortcut, square cursor", cursor, job });

  const patch = await json("/patches/current");
  assert.equal(patch.elements.length, 0);
  await until(() => json(`/patches/ai?patch_id=${patch.id}`), (s) => s.worker === "ready");
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  const holdStatus = async (route) => { await gate; await route.continue(); };
  await page.route("**/patches/ai?*", holdStatus);
  await startBox([480, 880], [290, 550]);
  await shot("drawing");
  const response = page.waitForResponse((r) => /\/patches\/\d+\/ai$/.test(r.url()) && r.request().method() === "POST");
  await page.mouse.up();
  const submitted = await response;
  assert.equal(submitted.status(), 202);
  const task = await submitted.json();
  assert.deepEqual(task.box, [290, 550, 480, 880]);
  await shot("pending");
  await writeFile(`${artifacts}-pending.aria.txt`, await page.locator("body").ariaSnapshot());
  await select("job-switcher", "job-Podocyte");
  await page.keyboard.press("r");
  resume();
  const completed = await until(() => json("/patches/current"), (p) => p.elements.some((el) => el.id === `ai-${task.id}`));
  await until(() => page.getByTestId("ai-queue").locator("summary").innerText(), (s) => s === "AI ready");
  const polygon = completed.elements.find((el) => el.id === `ai-${task.id}`);
  assert.equal(completed.elements.length, 1);
  assert.equal(polygon.type, "polygon");
  assert.equal(polygon.jobId, job.id);
  for (const ring of [polygon.points, ...(polygon.holes ?? [])])
    assert.ok(ring.every(([x, y]) => x >= 290 && x < 480 && y >= 550 && y < 880));
  await page.keyboard.press("l");
  await shot("result");
  await writeFile(`${artifacts}-result.aria.txt`, await page.locator("body").ariaSnapshot());
  await page.keyboard.press("Control+z");
  await until(() => json("/patches/current"), (p) => p.elements.length === 0);
  await page.keyboard.press("Control+Shift+z");
  await until(() => json("/patches/current"), (p) => p.elements.length === 1);
  await page.reload();
  await root.waitFor();
  await ready();
  assert.deepEqual((await json("/patches/current")).elements, completed.elements);
  results.push({ check: "real GPU prediction, original job, exact crop, undo/redo, reload", task, polygon });

  // Hold submissions at the browser boundary to exercise cancellation and retries deterministically.
  const mocked = [];
  let failNext = false;
  await page.route(/\/patches\/\d+\/ai$/, async (route) => {
    const body = route.request().postDataJSON();
    mocked.push(body);
    if (failNext) {
      failNext = false;
      await route.fulfill({ status: 503, json: { detail: "Verification retry" } });
    } else {
      await route.fulfill({ status: 202, json: { ...body, patch_id: patch.id, status: "queued", error: null } });
    }
  });
  await page.keyboard.press("a");
  await startBox([600, 450], [800, 600]);
  await page.mouse.up();
  await until(async () => mocked.length, (n) => n === 1);
  await startBox([100, 300], [220, 400]);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  assert.equal(mocked.length, 1);
  assert.match(await page.getByTestId("ai-queue").innerText(), /1 pending/);
  await page.keyboard.press("Control+z");
  await until(() => page.getByTestId("ai-queue").innerText(), (text) => !text.includes("pending"));
  assert.equal((await json("/patches/current")).elements.length, 1);

  for (const key of ["Escape", "Control+z", "l"]) {
    await page.keyboard.press("a");
    await startBox([100, 300], [220, 400]);
    await page.keyboard.press(key);
    await page.mouse.up();
  }
  await page.keyboard.press("a");
  await startBox([100, 300], [220, 400]);
  await root.dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
  await startBox([100, 300], [101, 301]);
  await page.mouse.up();
  assert.equal(mocked.length, 1);
  results.push({ check: "Escape prioritizes draft; undo cancels queued box; aborted and tiny drags do not submit" });

  const s = await bounds();
  await root.dispatchEvent("wheel", { clientX: s.left + 600 * s.scale, clientY: s.top + 500 * s.scale, deltaY: -300, ctrlKey: true });
  await root.dispatchEvent("wheel", { deltaX: 50, deltaY: 20 });
  failNext = true;
  await startBox([750, 600], [600, 450]);
  await page.mouse.up();
  await page.getByTestId("ai-queue").locator("summary").click();
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
  assert.deepEqual(mocked.at(-1).box, [600, 450, 750, 600]);
  const failed = mocked.at(-1);
  await select("job-switcher", "job-GBM");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await until(async () => mocked.length, (n) => n === 3);
  const retry = mocked.at(-1);
  assert.deepEqual(retry.box, failed.box);
  assert.equal(retry.job_id, failed.job_id);
  assert.notEqual(retry.id, failed.id);
  await page.getByTestId(`ai-cancel-${retry.id}`).click();
  results.push({ check: "zoom/pan, reverse drag, failed box retry retains crop and job", failed, retry });

  const proof = execFileSync("sqlite3", ["-cmd", ".timeout 5000", "-json", state.sqlite,
    "select id, job_id, status, input, elapsed_ms from ai_tasks;"], { encoding: "utf8" });
  await writeFile(`${artifacts}-checks.json`, JSON.stringify({ feature: "features/ai-annotation.md", results, posts }, null, 2));
  await writeFile(`${artifacts}-sqlite.json`, proof);
  await writeFile(`${artifacts}-me.json`, JSON.stringify(await json("/me"), null, 2));
  console.log(JSON.stringify({ ok: true, checks: results.length, artifacts }));
}
