# Tissue regions, tiled viewing and slide map

Every patch is displayed from the slide's image pyramid: `PatchCanvas` draws 256 px tiles from `/patches/{id}/tiles/{z}/{x}/{y}` for the visible part at the zoom's level, onto a `patch-tiles` canvas below the `patch-marks` annotation canvas. The `[data-image-plane]` element carries the patch size (`data-width`, `data-height`) and the zoom/pan transform. It gets `data-loaded` once the first visible tiles have arrived.

Colored images outside ELMI (histology with an OME pixel size) are split into tissue regions: bounding boxes of the tissue mask, padded by 800 µm. Tissue closer than 2 mm counts as one piece; separate pieces keep their own, possibly overlapping, boxes, and boxes nested inside another are dropped. Regions wider than 50 mm are split into chunks with 3 mm overlap. These sizes were tuned while the scale was read 10× too fine, so they are large in true units. Annotations are stored one row per element in full-image pixels with a bounding box, so overlapping regions show the same marks, shifted into each patch's coordinates. Every other image, at any size, is one patch showing the whole image, without a minimap. Next visits a slide's regions row by row (top, then left), then moves to the next image in the dataset's [image list](image-list.md) order. A minimap on the right, just above the control row, shows the regions, the current region in amber, visited ones in green, and a white viewport box once zoomed in.

Histology prompts use Meta's SAM ViT-H (`sam-vit_h`) for every job; ELMI jobs keep µSAM EM and the GBM model. Histology AI tiles are 5 mm cores with a 2 mm halo, capped at 3072 px cores with a 512 px halo. Real slides (0.24 or 0.49 µm/px) always hit the caps, so any box up to 1024 px fits; on the fixture, boxes up to 1600 px fit. Patches up to `FULL_IMAGE_MAX` queue all AI embeddings on open. Larger regions and whole images call `/patches/{id}/prepare` with the visible rectangle 1 s after the view settles. Views covering more than 16 AI tiles are skipped. Prompts compute any missing tile on demand.

## Driving it

Start `tests/girder_fixture.py` and set `VERIFY_GIRDER_API_URL` as described in [AI annotation](ai-annotation.md). The fixture serves three copies of a procedural 30000 × 12000 px slide at 2.5 µm/px under Verification images → Histology, with pyramid tiles. Their metadata differs: `slide` (H&E) and `slide-pas` are in case-2, and `slide-b` (PAS) is in case-10. Open `tab-images`, `folder-fixtures`, `folder-histo`, and wait for `slide-map`; the first image is `slide`.

Expect three regions: the tissue strip split into two chunks of 11423 × 6661 px starting at x = 178 and 10401, and a fragment near x = 24670. The wheel zooms up to 2 screen pixels per image pixel. Fixture glomeruli are 760 px (1.9 mm) disks; one sits at slide (5782, 5406).

```bash
sqlite3 "$(./scripts/verify-rhino-annotator sqlite)" \
  "select item_id, nm_per_px, histo, grid, levels from slides; select left, top, width, height from patches where girder_item_id = 'slide' and grid is not null;"
```

## Performance

`browser script --file .cursor/skills/verify-rhino-annotator/features/viewer-perf.mjs` zooms and pans `slide` and the ELMI `tem` fixture under 4x CPU throttling with a cold cache, and writes frame times, long-task time, tile requests, and minimap view-box moves to `artifacts/viewer-perf/$PERF_LABEL.json`. `PERF_TRACE=1` saves a Chrome trace, `PERF_PROFILE=1` a CPU profile, and `PERF_HIDE=<selector>` hides an element to A/B its cost. Headless Chromium rasterizes in software, so compare runs against each other rather than against real hardware.
