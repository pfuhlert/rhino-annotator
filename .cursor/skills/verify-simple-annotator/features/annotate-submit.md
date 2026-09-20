# Annotate and next

Annotate and next records point and polygon marks on the current crop, then loads the next crop.

## Sub-features

- `tool-point` places a point with tool Point (P).
- `tool-polygon` traces a polygon with tool Polygon (L).
- `tool-brush` paints a filled region with tool Brush (R); erase (Shift or right-drag) can cut a hole.
- `next-empty` advances with zero marks.
- `next-save` inserts an `annotations` row.

## How to get to it (user POV)

- After login, the crop and toolbar are on `/annotate`.
- Choose Point, Polygon, or Brush, mark the crop, choose Next (N).

## Driving it with Playwright

Preconditions:

- Isolated stack is healthy and a user is on `/annotate`.

- **Point.** Open `tool-switcher`, click `tool-point`, then click inside `patch-canvas`.
- **Polygon.** Open `tool-switcher`, click `tool-polygon`, hold the left mouse button and draw, then release to close.
- **Brush.** Open `tool-switcher`, click `tool-brush`, drag to paint, optionally Shift-drag to erase a hole, then switch to Polygon to see the outline.
- **Next.** Click `next`. A new crop loads (`patch-canvas` still present).
- **Proof.** Screenshot after marks and after next. `sqlite3 $(./scripts/verify-simple-annotator sqlite) 'select count(*) from annotations;'` is at least 1. Copy the query output into `artifacts/` before `down`.

## Gotchas

- Marks are a canvas overlay on an `img` inside `patch-canvas`; click the image, not the header.
- Empty next is allowed and does not increment `done_count`.
- `down` deletes the verify SQLite; export counts first.
