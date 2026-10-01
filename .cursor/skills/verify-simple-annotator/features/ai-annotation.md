# AI annotation

Point and AI Box submit prompts to the GPU worker for every job. Both reuse image embeddings prepared in the background and persisted in SQLite; predictions become ordinary editable polygons.

## Sub-features

- Automatic AI inference from Point (P), replacing the dot with a polygon and saving no duplicate point.
- Local GPU inference, queue feedback and cancellation. A failed point or box disappears from the canvas and the queue opens with the reason, which clears itself after about five seconds; there is no retry or dismiss button.
- Drawing and navigation while requests are pending.
- Ordinary polygon editing, undo/redo and persistence.
- Opening an image queues 3 µm tiles with 0.5 µm context margins without waiting for encoding; uncalibrated images use 384/64 pixels and have no scale bar.
- Embeddings persist across worker restarts and are shared across visits, prompt types, and jobs using the same model.
- The GBM job uses its fine-tuned model on one whole-image embedding; other jobs use the default model.
- Cached image revisits do not write to the embedding queue; temporary database contention retries without repeating inference.
- AI Box (A) uses surrounding image context and clips its resulting object to the drawn box.

## How to get to it (user POV)

Open a dataset, select any job, and choose Point (P). Click inside an object; R returns to brush corrections. Open the AI indicator to manage pending requests.

## Driving it with Playwright

Use the verify helper with unique `VERIFY_STATE`, `VERIFY_STORAGE`, and `VERIFY_RUN_ID`. It runs the normal `npm run dev` command. Leave `SIMPLE_ANNOTATOR_AI` unset: the GPU worker must start automatically, report ready, and complete a point prediction without an extra flag.

For real inference, run `tests/girder_fixture.py /path/to/TEM.png --nm-per-px SCALE` from `backend/` with the prescribed UV environment. Set `VERIFY_GIRDER_API_URL=http://127.0.0.1:8199` when starting verify. The helper only accepts a localhost fixture and supplies a dummy token. Select Verification images → ELMI on the Datasets tab (`tab-datasets`, `folder-fixtures`, `folder-elmi`), then `job-Mitochondria`.

Use the helper's browser commands to choose `tool-point` (without pressing A), click the canvas, immediately switch to the brush and draw, and navigate Next/Previous. Capture the pending dot and the resulting outline, an ARIA snapshot, and SQLite rows from `ai_tasks` and `annotations`. Confirm the AI click saves exactly one polygon and no point; manual brush marks coexist on the original patch and job. Undo/redo the prediction and reload to check that the original dot never returns. Repeat on Nucleus or Podocyte to verify Point AI is available outside Mitochondria. The closed job selector must not consume P as typeahead.

Choose `tool-ai-box` or press A on any job. Drag around one object, including in reverse direction and with zoom/pan. Check the pending rectangle, the square cursor at hotspot 8,8, and the request's integer `box` bounds. Confirm that one polygon is saved under the submitting job, all vertices stay within those bounds, and no rectangle annotation is saved. Reload and undo/redo to verify persistence. Check that tiny drags, Escape during drawing, pointer cancellation, and switching tools/jobs/images during drawing do not enqueue. Fail a box and confirm the queue opens with the reason, offers no Retry or Dismiss, no longer draws the box, and clears and closes itself after about five seconds. Use `browser script` interception to make pending/cancellation and failure checks deterministic, separately from real GPU inference.

Run `browser script --file .cursor/skills/verify-simple-annotator/features/embeddings.mjs` with the 1024 × 1024 TEM fixture and `--nm-per-px 5` to exercise adaptive tiling. It checks calibration and scale-bar visibility, automatic preparation before prompting, Point AI on Nucleus, Box AI on Podocyte, shared cache reuse, manual annotation, history, and reload. Evidence is saved under `artifacts/embeddings-*`. Inspect `ai_embeddings` for ready rows containing tensors; use a fresh GPU predictor with image fetching/encoding disabled to prove that persisted tensors can serve both prompts after its memory cache is discarded.

For the 1024×1024 TEM fixture, run `browser script --file .cursor/skills/verify-simple-annotator/features/ai-box.mjs` after `login-proof`. It checks real inference on the Nucleus job, followed by intercepted queue lifecycle checks, and saves `artifacts/ai-box-*` evidence. Native cursor appearance is checked through its inline SVG data URI and computed hotspot; native cursors are absent from browser screenshots.

For queue shortcut regression, submit two pending tasks: Escape cancels the newest, then Ctrl+Z cancels the remaining task before changing annotation history. With the queue empty, Ctrl+Z and Ctrl+Shift+Z undo/redo the prediction. A `browser script` can hold queue responses to make ordering deterministic and count capture-phase `window` keydown registrations: tool, job, and queue updates must not reattach the listener.

For the GBM model, serve a real UKE image such as `/data/data/elmi/uke/clahe/samples_vni/R1174-26-1.TIF` (converted to PNG) with `--nm-per-px 0.48828125`, then run `browser script --file .cursor/skills/verify-simple-annotator/features/gbm-model.mjs` after `login-proof`. Its click points lie on that image's membrane. It checks that GBM prompts record the GBM model and share one ready 2048 × 2048 embedding, and that a Mitochondria prompt uses the default model. Evidence is saved under `artifacts/gbm-model/`.

## Gotchas

Opening an image schedules encoding. A prompt can wait for its tile if preparation has not finished; requested predictions take priority between background tiles. Pending markers are temporary and are not saved as point annotations. The scale bar and model use image pixels, while browser click positions are CSS pixels. The worker survives closing the browser, but remains a child of the verify supervisor and stops with this run. Each verification run has its own build directory under `frontend/.next-verify/`.
