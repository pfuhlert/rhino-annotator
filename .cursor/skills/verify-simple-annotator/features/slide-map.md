# Tissue regions, tiled viewing and slide map

Every patch is displayed from the slide's image pyramid: `PatchCanvas` draws 256 px tiles from `/patches/{id}/tiles/{z}/{x}/{y}` for the visible part at the zoom's level, onto a `patch-tiles` canvas below the `patch-marks` annotation canvas. The `[data-image-plane]` element carries the patch size (`data-width`, `data-height`) and the zoom/pan transform. It gets `data-loaded` once the first visible tiles have arrived.

Colored images outside ELMI (histology with `mm_x`) are split into tissue regions: bounding boxes of the tissue mask, padded by 250 µm and merged when they overlap. Regions wider than 5 mm are split into chunks with 300 µm overlap. Other large images use `CROP_SIZE` tiles with `CROP_OVERLAP`, and small images are one tile. Patches are visited row by row (top, then left), then a random next slide. A minimap in the bottom-right corner shows the regions, the current region in amber, visited ones shaded, and a white viewport box once zoomed in.

Histology prompts use Meta's SAM ViT-H (`sam-vit_h`) for every job; ELMI jobs keep µSAM EM and the GBM model. Histology AI tiles are 500 µm cores with a 200 µm halo, so any box up to 400 µm fits. Patches up to `FULL_IMAGE_MAX` queue all AI embeddings on open. Larger regions call `/patches/{id}/prepare` with the visible rectangle 1 s after the view settles. Views covering more than 16 AI tiles are skipped. Prompts compute any missing tile on demand.

## Driving it

Start `tests/girder_fixture.py` and set `VERIFY_GIRDER_API_URL` as described in [AI annotation](ai-annotation.md). The fixture serves a procedural 30000 × 12000 px H&E slide at 0.25 µm/px under Verification images → Histology, with pyramid tiles. Open `tab-datasets`, `folder-fixtures`, `folder-histo`, and wait for `slide-map`.

Expect three regions: the tissue strip split into two chunks of about 11852 × 8021 px starting at x = 0 and 10652, and a fragment near x = 23990. Ctrl+wheel zooms up to 2 screen pixels per image pixel. Fixture glomeruli are 190 µm disks; one sits at slide (5782, 5406).

```bash
sqlite3 "$(./scripts/verify-simple-annotator sqlite)" \
  "select item_id, nm_per_px, histo, grid, levels from slides; select left, top, width, height from patches where girder_item_id = 'slide' and grid is not null;"
```
