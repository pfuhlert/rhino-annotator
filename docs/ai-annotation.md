# AI annotation

Start the app and its separate GPU worker with `npm run dev`. The launcher installs the `ai` Python dependencies automatically; the published μSAM EM organelle checkpoint is downloaded on first use, and the GBM checkpoint is read from the shared `/data` folder (see [Models](#models)). The worker stays loaded and queued requests survive browser closure or worker restarts.

Choose any job, select **Point (P)**, and click inside a structure. The GBM job uses a model fine-tuned for capillary membranes; every other job uses the general EM organelle model. A temporary dot appears immediately and is replaced by the predicted outline; no separate point annotation is saved. Continue clicking, draw with **R**, or navigate away while inference runs. Results become ordinary editable polygons on the original image and job. **Escape** cancels the latest pending click on the current image. The AI queue shows pending requests with cancellation. When a point or box fails, its marker disappears and the queue opens to say why for about five seconds, then clears itself; there is no retry, so click or draw again, or use the brush. Undo removes a completed annotation through normal history; Ctrl+Z cancels a pending click first.

Opening an image queues embedding preparation in the separate GPU worker for the default model and, when a job with its own model is selected, for that model too. The API records the work after sending the image response; image display and manual annotation do not wait for queue insertion or the encoder. Calibrated images target a 3 µm square core with 0.5 µm of context on each side: pixel sizes are `round(3000 / nm_per_px)` and `round(500 / nm_per_px)`. Small images use their full rectangular extent. Missing or invalid calibration uses `tile_shape=(384, 384)` and `halo=(64, 64)` without displaying a scale bar. Both Point and AI Box reuse these embeddings. The GBM model always uses one whole-image embedding for images up to 4096 pixels per side, because the membrane spans the frame and a click on a smaller tile fails at the tile edge; larger images fall back to the tiles below. A prompt submitted before preparation finishes takes priority over the remaining background tiles and prepares its required tile first.

Context is clipped to image edges. At extreme calibrations, cores are at least 64 pixels and inputs including context are at most 4096 pixels per side; regions larger than that cap use cores up to 3072 pixels. These bounds limit tile count and encoding memory independently of the configurable `FULL_IMAGE_MAX` display threshold. The physical sizes are an application default, not a μSAM recommendation.

The tile containing a point supplies its embedding. Boxes use the tile at their center when it contains the entire box; on this regular grid, searching other tiles cannot find a better fit. A whole-image embedding is also prepared for images up to 4096 pixels per side, providing a fallback for larger boxes and point predictions that touch an artificial tile boundary. Larger regions stay tiled; oversized boxes receive HTTP 400 before a prediction task is created. Tiling and the scale bar share the same calibration lookup.

**AI Box (A)** is available for every job and uses that job's model. Draw a tight rectangle around one object and release to start inference. The square cursor follows the Polygon tool's crosshair design. The rectangle is rounded to pixel boundaries and clamped to the image. The decoder receives the box as a spatial prompt on the cached embedding, including its surrounding image context. The mask is clipped to the drawn box, then its largest connected object becomes one editable polygon with holes preserved. The selected job supplies the annotation label; it is not a semantic prompt to the model. The general model's quality may vary for structures beyond the organelles it was trained on.

The pending rectangle uses the existing AI queue, including cancellation and failure messages. Escape or Ctrl+Z cancels an unfinished box before affecting pending predictions. Changing tools, jobs, or images also discards an unfinished box. Completed predictions remain on their original image and job.

## Configuration

- `SIMPLE_ANNOTATOR_AI=0`: explicitly disable the worker and skip installing AI dependencies (for development without a GPU). AI is enabled by default.
- `SIMPLE_ANNOTATOR_AI_DEVICE`: defaults to `cuda`; `cpu` is useful for debugging.
- `SIMPLE_ANNOTATOR_MODEL_DIR`: checkpoint cache, default `~/.cache/simple-annotator`.
- `SIMPLE_ANNOTATOR_GBM_CHECKPOINT`: path of the GBM checkpoint when `/data` is mounted elsewhere. The file must still match the pinned checksum.

`AI_MODELS` in `config.py` registers each model (architecture, checkpoint, checksum, whole-image tiling) and `JOB_AI_MODELS` maps job names to non-default models. A model adapter implements `prepare(request)` to persist embeddings and `predict(request)` to return `points` and optional `holes` in image-local pixel coordinates. Prompts capture the model, source region, calibration, and job when enqueued. The frontend has no model-specific geometry handling.

To attach a worker to an already-running app, run from `backend/`, using the repository's Python environment rules. On Ceph/NFS:

```sh
UV_CACHE_DIR=/tmp/uv-cache VIRTUAL_ENV="$HOME/.uv-local/venvs/simple-annotator" UV_PROJECT_ENVIRONMENT="$HOME/.uv-local/venvs/simple-annotator" uv run --active --extra ai python -m simple_annotator.ai_worker
```

The worker and API must share `SIMPLE_ANNOTATOR_SQLITE` and image-source settings. One worker owns each database. Its failure leaves manual annotation available. A restarted worker resumes unfinished tasks; cancellation prevents a late result from being committed.

Restart the AI worker after changing inference code. The API's development reload does not reload a separately started worker; an older worker can report generic segmentation failures for newly added prompt types.

## Persistence and performance

SQLite stores the queues, annotation geometry, and embedding tensors in `ai_embeddings`. Each embedding is an uncompressed NumPy archive containing float32 features and the predictor's original/input dimensions; loading disables pickle. The cache key includes the image-source URL, image ID, absolute pixel region, model, and preprocessing/checkpoint version. Visits, users, prompt types, and jobs using the same model share embeddings for identical pixels; each model has its own embeddings. Source image IDs are assumed to identify immutable pixels; replacing pixels under the same ID requires invalidating its cached embeddings.

The worker persists each completed tile in a short transaction, without holding a database lock during network fetching or GPU encoding. Up to 16 embeddings stay in GPU memory; evicted embeddings load from SQLite. Restarting the worker resumes unfinished preparation while retaining completed tensors. Failed preparation retries when the image is reopened or a prompt needs that tile. One float32 SAM embedding takes about 4 MiB, plus a small amount of metadata. Without calibration, a 1024 × 1024 image has nine tiles and one whole-image fallback, about 40 MiB in total; at 5 nm/pixel it uses four tiles and one fallback, about 20 MiB.

Reopening an image reads its cache entries and queues only missing or failed embeddings. Ready or already-pending tiles require no queue write. Worker database operations retry SQLite busy/locked errors after rolling back and closing the affected session; saving a computed embedding or prediction does not repeat inference while waiting for the lock. Other errors retain the normal failure behavior. This handles temporary contention, not stale filesystem locks.

Background queue insertion uses its own session and tries up to three times on database contention. If it still fails, it logs the error and leaves the saved visit intact. Reopening the image can queue preparation again; prompts can also prepare their required embeddings on demand. Tensors and their ready status commit together before entering the worker's memory cache, so a cache hit needs no completion write.

Both manual edits and completed predictions use one atomic add/update/delete operation, so saving a canvas cannot erase an unseen background result. Stable element IDs also preserve editing and undo across inference completion.

The browser polls every 200 ms while work is pending and every 1.5 seconds when idle. Completed geometry is transferred once per view using a completion cursor. The worker polls the queues every 80 ms and checks for requested predictions between background tiles. Model loading and image encoding happen entirely outside the API process. Once its embedding is available, either a point or box only runs prompt decoding and polygon extraction.

## Models

- **Default:** μSAM's [EM organelle ViT-L model, model-zoo version 1.2](https://uk1s3.embassy.ebi.ac.uk/public-datasets/bioimage.io/humorous-crab/1.2/files/vit_l.pt), verified against the checksum published in the [μSAM model registry](https://github.com/computational-cell-analytics/micro-sam/blob/main/micro_sam/util.py).
- **GBM:** a fine-tune of that model on the `fpwdl` membrane dataset, `/data/results/microsam/checkpoints/fpw_em_finetune_clahe/best_only_weights.pt`. It was trained on images with a 1–99 percentile contrast stretch, which matches the pixels the image server returns for UKE images. The worker checks every checkpoint's checksum at startup. If a checkpoint is missing, has changed, or fails to download, the worker logs the error, keeps serving the jobs whose models loaded, and fails the other jobs' prompts with a message suggesting the brush.

On the one GBM ground-truth image (`R1174-26-1`), five clicks along the membrane covered it with 0.74 IoU using the GBM model, against 0.05 with the default model. The small SAM inference package loads both checkpoints directly; the desktop annotation/training dependencies are unnecessary for this worker.
