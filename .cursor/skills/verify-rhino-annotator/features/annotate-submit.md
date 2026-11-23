# Annotate and next

Annotate and next records polygons on the current image, then loads the next image. Point and AI Box generate polygons through the GPU worker; Polygon and Brush draw them manually. Existing point annotations remain editable.

## Sub-features

- `tool-cycle` moves Point → Polygon → Brush → AI Box with Tab (Shift+Tab reverses).
- `tool-point` prompts AI for every job with Point (P); its fixed-size dot-and-ring cursor marks the exact click location.
- `tool-polygon` traces a polygon with tool Polygon (L); a lasso cursor identifies the tool and a small crosshair marks the drawing position.
- `image-boundaries` keeps new points, polygon drawing, vertex edits, and whole-shape movement inside the image. Outside starts are ignored; a partially overlapping brush remains usable. Whole-shape drags retain their grab offset when constrained by an edge.
- `tool-brush` paints a filled region with tool Brush (R); erase (Shift or right-drag) can cut a hole.
- `next-empty` advances with zero marks.
- `next-save` inserts an `annotations` row.

## How to get to it (user POV)

- After login, the image and toolbar are on `/annotate`.
- Tab cycles tools, or choose AI Point, Polygon, Brush, or AI Box, mark the image, choose Next (N).

## Driving it with Playwright

Preconditions:

- Isolated stack is healthy and a user is on `/annotate`.

```bash
./scripts/verify-rhino-annotator browser \
  goto --path /annotate \
  wait --testid annotate-app \
  press --key Tab \
  wait --testid tool-switcher --text "Brush" \
  press --key Shift+Tab \
  wait --testid tool-switcher --text "Polygon" \
  select --testid tool-switcher --option tool-polygon \
  drag --testid patch-canvas --from 500,220 --via 800,240 --to 640,500 \
  select --testid tool-switcher --option tool-brush \
  drag --testid patch-canvas --from 560,300 --to 760,460 \
  screenshot --out .cursor/skills/verify-rhino-annotator/artifacts/mark.png \
  click --testid next \
  snapshot --out .cursor/skills/verify-rhino-annotator/artifacts/mark-after.aria.txt
```

Cursor check: choose Point and hover the canvas. Point and Polygon use native SVG cursors (hotspots 12,12 and 8,8); verify their computed cursor URL and asset response with `browser script`. Native cursors do not appear in screenshots. Press L, R, and P without moving the pointer to check tool switching. Brush uses a native SVG circle whose screen size follows the brush radius and stays the same at every zoom until it reaches 2 image pixels. Circles exceeding the browser’s 128px cursor limit, or crossing an image edge, use a separate outline clipped to the image with `--cursor none`. Point drags stop on the last valid image pixel; polygon outlines may reach the exact image edge. Point and Polygon show `not-allowed` in empty margins; Brush does too when its footprint no longer overlaps the image. Existing edge handles remain selectable. Pointer movement must not repaint the annotation canvas; scrolling must keep the circle centered under the pointer. Hover an existing annotation and assert `--cursor grab` to check its edit cursor.

Brush cursor regression: run `./scripts/verify-rhino-annotator browser script --file .cursor/skills/verify-rhino-annotator/features/brush-cursor.mjs` after `login-proof`. It checks native and oversized cursors, pan/zoom clamping, wheel coordinates, resize, tool switching, zero bounds reads or canvas redraws during idle brush movement and leave, one transform per visible outline movement with no visibility toggles, cached-origin updates, scale-bar mounting, polygon hover cleanup, toolbar layering, and paint/erase coverage while zoomed and panned. Evidence is written to `artifacts/brush-cursor-*`.

Image boundary regression: run `./scripts/verify-rhino-annotator browser script --file .cursor/skills/verify-rhino-annotator/features/image-bounds.mjs` after `login-proof`. It closes the sidebar to expose the margins, checks outside starts and stationary tool changes, constrained drawing and editing, overshooting an edge and reversing without losing the grab offset, undo/redo and persistence, partial brush paint/erase and live preview clipping, and hover feedback after zoom and resize without pointer movement. Evidence is written to `artifacts/image-bounds-*`.

Shortcut regression: after selecting a job and closing the menu, press N/F to advance and B/ArrowLeft to return. The selected job must stay unchanged; the selector must not consume navigation keys as typeahead. Repeat P/L/R and Tab/Shift+Tab after job and image changes.

- **Proof.** Screenshot after marks. `sqlite3 $(./scripts/verify-rhino-annotator sqlite) 'select elements from annotations;'` includes `polygon`. Copy that output into `artifacts/` before `down`. Verify Point AI using the real-image fixture in [AI annotation](ai-annotation.md); `image-bounds.mjs` seeds a legacy point through the API solely to verify editing older annotations.

## Gotchas

- `--at` / `--from` are CSS pixels on `patch-canvas`, not image pixels. Default verify window is 1280×720; the 1024 × 1024 placeholder image is letterboxed, so x < ~280 is gutter and cannot start a point or polygon. Close the sidebar to test that margin. Use ~`640,360` for a point.
- A straight `drag` simplifies to fewer than 3 points and is dropped. Use `--via` so the path has three corners.
- Tab is handled on `window`; do not Tab while a select is open.
- `select` waits for the menu to close; a drag right after an option click otherwise loses `pointerdown` to the dismiss layer.
- Brush on the same job unions into existing polygons, so multiple strokes may remain one `polygon`.
- Marks are a canvas overlay on an `img` inside `patch-canvas`; click the image, not the header.
- Empty next is allowed and does not increment `done_count`.
- `down` deletes the verify SQLite; export `elements` first.
