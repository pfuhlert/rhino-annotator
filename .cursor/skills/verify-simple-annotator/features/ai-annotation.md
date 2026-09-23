# AI annotation

The normal Point tool submits a scale-aware local crop to a persistent GPU queue for supported jobs; predictions replace the temporary dots and enter normal annotation editing and saving.

## Sub-features

- Automatic AI inference from Point (P), replacing the dot with a polygon and saving no duplicate point.
- Local GPU inference, queue feedback, cancellation and retry.
- Drawing and navigation while requests are pending.
- Ordinary polygon editing, undo/redo and persistence.
- Scale bar calibration determines the crop size.

## How to get to it (user POV)

Open an ELMI dataset, select Mitochondria, and choose Point (P). Click inside an object; R returns to brush corrections. Open the AI indicator to manage pending requests.

## Driving it with Playwright

Use the verify helper with unique `VERIFY_STATE`, `VERIFY_STORAGE`, and `VERIFY_RUN_ID`. It runs the normal `npm run dev` command. Leave `SIMPLE_ANNOTATOR_AI` unset: the GPU worker must start automatically, report ready, and complete a point prediction without an extra flag.

For real inference, run `tests/girder_fixture.py /path/to/TEM.png --nm-per-px SCALE` from `backend/` with the prescribed UV environment. Set `VERIFY_GIRDER_API_URL=http://127.0.0.1:8199` when starting verify. The helper only accepts a localhost fixture and supplies a dummy token. Select Verification images → ELMI with `folder-fixtures` and `use-folder-elmi`, then `job-Mitochondria`.

Use the helper's browser commands to choose `tool-point` (without pressing A), click the canvas, immediately switch to the brush and draw, and navigate Next/Previous. Capture the pending dot and the resulting outline, an ARIA snapshot, and SQLite rows from `ai_tasks` and `annotations`. Confirm the AI click saves exactly one polygon and no point; manual brush marks coexist on the original patch and job. Undo/redo the prediction and reload to check that the original dot never returns. Repeat using P immediately after selecting Mitochondria: the tool must change to Point while the job remains Mitochondria (the closed job selector must not consume the shortcut). Also check cancellation and a job without AI (its clicks must still save points).

For queue shortcut regression, submit two pending tasks: Escape cancels the newest, then Ctrl+Z cancels the remaining task before changing annotation history. With the queue empty, Ctrl+Z and Ctrl+Shift+Z undo/redo the prediction. A `browser script` can hold queue responses to make ordering deterministic and count capture-phase `window` keydown registrations: tool, job, and queue updates must not reattach the listener.

## Gotchas

The first crop requires encoding; nearby clicks reuse embeddings. Pending markers are temporary and are not saved as point annotations. The scale bar and model use image pixels, while browser click positions are CSS pixels. The worker survives closing the browser, but remains a child of the verify supervisor and stops with this run. Each verification run has its own build directory under `frontend/.next-verify/`.
