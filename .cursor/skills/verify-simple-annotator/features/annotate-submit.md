# Annotate and next

Annotate and next records point, polygon, and brush marks on the current crop, then loads the next crop.

## Sub-features

- `tool-cycle` moves Point → Polygon → Brush with Tab (Shift+Tab reverses).
- `tool-point` places a point with tool Point (P); its fixed-size dot-and-ring cursor marks the exact click location.
- `tool-polygon` traces a polygon with tool Polygon (L); a lasso cursor identifies the tool and a small crosshair marks the drawing position.
- `tool-brush` paints a filled region with tool Brush (R); erase (Shift or right-drag) can cut a hole.
- `next-empty` advances with zero marks.
- `next-save` inserts an `annotations` row.

## How to get to it (user POV)

- After login, the crop and toolbar are on `/annotate`.
- Tab cycles tools, or choose Point, Polygon, or Brush, mark the crop, choose Next (N).

## Driving it with Playwright

Preconditions:

- Isolated stack is healthy and a user is on `/annotate`.

```bash
./scripts/verify-simple-annotator browser \
  goto --path /annotate \
  wait --testid annotate-app \
  press --key Tab \
  wait --testid tool-switcher --text "Brush (R)" \
  press --key Shift+Tab \
  wait --testid tool-switcher --text "Polygon (L)" \
  select --testid tool-switcher --option tool-point \
  click --testid patch-canvas --at 640,360 \
  select --testid tool-switcher --option tool-polygon \
  drag --testid patch-canvas --from 500,220 --via 800,240 --to 640,500 \
  select --testid tool-switcher --option tool-brush \
  drag --testid patch-canvas --from 560,300 --to 760,460 \
  screenshot --out .cursor/skills/verify-simple-annotator/artifacts/mark.png \
  click --testid next \
  snapshot --out .cursor/skills/verify-simple-annotator/artifacts/mark-after.aria.txt
```

Cursor check: choose Point and hover the canvas. Point and Polygon use native SVG cursors (hotspots 12,12 and 8,8); verify their computed cursor URL and asset response with `browser script`. Native cursors do not appear in screenshots. Press L, R, and P without moving the pointer to check tool switching. Brush uses a native SVG circle scaled to the current brush radius and zoom. Circles exceeding the browser’s 128px cursor limit use a separate outline with `--cursor none`. Pointer movement must not repaint the annotation canvas; scrolling must keep the circle centered under the pointer. Hover an existing annotation and assert `--cursor grab` to check its edit cursor.

Brush cursor regression: run `./scripts/verify-simple-annotator browser script --file .cursor/skills/verify-simple-annotator/features/brush-cursor.mjs` after `login-proof`. It checks native and oversized cursors, pan/zoom clamping, wheel coordinates, resize, tool switching, zero bounds reads or canvas redraws during idle brush movement and leave, cached-origin updates, scale-bar mounting, polygon hover cleanup, toolbar layering, and paint/erase coverage while zoomed and panned. Evidence is written to `artifacts/brush-cursor-*`.

Shortcut regression: after selecting a job and closing the menu, press N/F to advance and B/ArrowLeft to return. The selected job must stay unchanged; the selector must not consume navigation keys as typeahead. Repeat P/L/R and Tab/Shift+Tab after job and image changes.

- **Proof.** Screenshot after marks. `sqlite3 $(./scripts/verify-simple-annotator sqlite) 'select elements from annotations;'` includes `point` and `polygon`. Copy that output into `artifacts/` before `down`.

## Gotchas

- `--at` / `--from` are CSS pixels on `patch-canvas`, not image pixels. Default verify window is 1280×720; a 1024 crop is letterboxed, so x < ~280 is gutter (`180,180` saved x=-142). Use ~`640,360` for a point.
- A straight `drag` simplifies to fewer than 3 points and is dropped. Use `--via` so the path has three corners.
- Tab is handled on `window`; do not Tab while a select is open.
- `select` waits for the menu to close; a drag right after an option click otherwise loses `pointerdown` to the dismiss layer.
- Brush on the same job unions into existing polygons, so `elements` may show one `polygon` plus the point, not a second mark.
- Marks are a canvas overlay on an `img` inside `patch-canvas`; click the crop, not the header.
- Empty next is allowed and does not increment `done_count`.
- `down` deletes the verify SQLite; export `elements` first.
