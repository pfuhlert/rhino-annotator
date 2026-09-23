# AI annotation

Start the app and its separate GPU worker with `npm run dev`. The launcher installs the `ai` Python dependencies automatically; the published μSAM EM organelle checkpoint is downloaded on first use. The worker stays loaded and queued requests survive browser closure or worker restarts.

Select **Mitochondria**, choose the normal **Point (P)** tool, and click inside a structure. Points automatically start AI inference for jobs with a configured model. A temporary dot appears immediately and is replaced by the predicted outline; no separate point annotation is saved. Continue clicking, draw with **R**, or navigate away while inference runs. Results become ordinary editable polygons on the original image and job. Jobs without a model retain normal point annotations. **Escape** cancels the latest pending click on the current image. The AI queue exposes cancellation, retry, and errors. Undo removes a completed annotation through normal history; Ctrl+Z cancels a pending click first.

The default crop is 3 µm across, using the same `nm_per_px` metadata as the scale bar. With no calibration it uses 512 pixels. Crops overlap so nearby clicks can reuse embeddings; crops expand if the selected structure touches an artificial boundary. The initial crop is bounded to 128–2048 pixels and up to 16 crop embeddings are cached. These are starting settings to tune on representative images.

## Configuration

- `SIMPLE_ANNOTATOR_AI=0`: explicitly disable the worker and skip installing AI dependencies (for development without a GPU). AI is enabled by default.
- `SIMPLE_ANNOTATOR_AI_DEVICE`: defaults to `cuda`; `cpu` is useful for debugging.
- `SIMPLE_ANNOTATOR_MODEL_DIR`: checkpoint cache, default `~/.cache/simple-annotator`.
- `SIMPLE_ANNOTATOR_AI_PROFILES`: optional JSON file mapping job names to profiles, replacing the defaults:

```json
{
  "Mitochondria": {
    "model": "microsam-em-1.2",
    "crop_nm": 3000,
    "crop_px": 512
  }
}
```

A model adapter implements `predict(request)` and returns `points` and optional `holes` in patch-local pixel coordinates. Register it in `ai_worker.py` and select its model key in a profile. Prompts capture the model, scale, source region, and job when enqueued. The frontend has no model-specific geometry handling.

To attach a worker to an already-running app, run from `backend/`, using the repository's Python environment rules. On Ceph/NFS:

```sh
UV_CACHE_DIR=/tmp/uv-cache VIRTUAL_ENV="$HOME/.uv-local/venvs/simple-annotator" UV_PROJECT_ENVIRONMENT="$HOME/.uv-local/venvs/simple-annotator" uv run --active --extra ai python -m simple_annotator.ai_worker
```

The worker and API must share `SIMPLE_ANNOTATOR_SQLITE` and image-source settings. One worker owns each database. Its failure leaves manual annotation available. A restarted worker resumes unfinished tasks; cancellation prevents a late result from being committed.

## Persistence and performance

SQLite stores the queue and annotation geometry. Both manual edits and completed predictions use one atomic add/update/delete operation, so saving a canvas cannot erase an unseen background result. Stable element IDs also preserve editing and undo across inference completion.

The browser polls every 200 ms while work is pending and every 1.5 seconds when idle. Completed geometry is transferred once per view using a completion cursor. The worker polls the queue every 80 ms. Model loading and image encoding happen entirely outside the API process. A click only runs the decoder when its crop is cached.

The checkpoint is μSAM's [EM organelle ViT-B model, model-zoo version 1.2](https://uk1s3.embassy.ebi.ac.uk/public-datasets/bioimage.io/noisy-ox/1.2/files/vit_b.pt), verified against the checksum published in the [μSAM model registry](https://github.com/computational-cell-analytics/micro-sam/blob/main/micro_sam/util.py). The small SAM inference package loads the checkpoint directly; the desktop annotation/training dependencies are unnecessary for this worker.
