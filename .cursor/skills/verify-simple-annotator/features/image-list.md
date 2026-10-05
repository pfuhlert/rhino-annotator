# Image list

The Images tab is the folder tree; the selected folder's images expand beneath its row (or beneath the level header when the selected folder is the open level). They are grouped by case (`meta.case_id`, otherwise the parent folder name) and sorted naturally. Each row shows stain, magnification (Girder's `image_magnification / 10`, snapped to an objective power) and progress: `visited/regions` for multi-region images, ✓ for visited single-region images, nothing for images that have not been opened yet. Clicking a row opens its first unvisited region. Next and Prev walk regions, then images, in list order, and wrap at both ends. The stain filter is stored in `users.stain_filter`, applies to the list and to Next/Prev, and is cleared when the folder changes.

## Sub-features

- `image-groups` shows the current image's group expanded and the others collapsed.
- `image-open` opens a clicked image at its first unvisited region (`POST /patches/open`).
- `image-order` walks every region of an image before the next image, and Prev crosses back to the previous image's last region.
- `stain-filter` selects several stains at once, hides other stains, makes Next skip them, survives reload, and clears on a folder switch.
- `pinned-folder` keeps the level header, selected folder and stain menu fixed and opaque while images scroll.
- `image-progress` updates the current row from the patch without refetching `/images` between regions.

## How to get to it (user POV)

- Open the sidebar and choose Images. Pick another folder in the same tree; its images replace the old ones under it.
- Open the stain menu ("All stains") and tick one or more stains; "Show all stains" clears the filter.

## Driving it with Playwright

Preconditions:

- `tests/girder_fixture.py` runs and verify was started with `VERIFY_GIRDER_API_URL` (see [AI annotation](ai-annotation.md)).
- A fresh user from `login-proof`; the script expects to start on the first Histology image.

```bash
./scripts/verify-simple-annotator login-proof
./scripts/verify-simple-annotator browser script \
  --file .cursor/skills/verify-simple-annotator/features/image-list.mjs
```

The script asserts each sub-feature and writes `artifacts/image-list-results.json` plus `image-list-{opened,filtered,wrapped,elmi}.png`.

## Gotchas

- The stain menu renders inside the sidebar, not in a portal: the overlay closes on any pointerdown outside its panel.
- The level header and the selected folder (with the stain menu) are sticky. The script compares them at rest and scrolled to the bottom in a 330 px tall viewport; they must be pixel-identical and keep the 34 px row pitch.
- The list refetches when the open image changes (not per region) so images left behind keep their final progress.
