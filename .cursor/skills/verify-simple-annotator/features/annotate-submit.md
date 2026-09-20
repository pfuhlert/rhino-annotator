# Annotate and next

Annotate and next records point, polygon, and brush marks on the current crop, then loads the next crop.

## Sub-features

- `tool-cycle` moves Point → Polygon → Brush with Tab (Shift+Tab reverses).
- `tool-point` places a point with tool Point (P).
- `tool-polygon` traces a polygon with tool Polygon (L).
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
