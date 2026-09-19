# Annotate and submit

Annotate and submit records point and polygon marks on the current crop, then loads the next crop.

## Sub-features

- `tool-point` places a point with tool Point (P).
- `tool-polygon` traces a polygon with tool Polygon (L) and Enter to close.
- `submit-empty` submits zero marks.
- `submit-save` inserts an `annotations` row.

## How to get to it (user POV)

- After login, the crop and toolbar are on `/annotate`.
- Choose Point or Polygon, mark the crop, choose Submit (F).

## Driving it with Playwright

Preconditions:

- Isolated stack is healthy and a user is on `/annotate`.

- **Point.** Click `tool-point`, then click inside `patch-canvas`.
- **Polygon.** Click `tool-polygon`, hold the left mouse button and draw, then release to close.
- **Submit.** Click `submit`. A new crop loads (`patch-canvas` still present).
- **Proof.** Screenshot after marks and after submit. `sqlite3 $(./scripts/verify-simple-annotator sqlite) 'select count(*) from annotations;'` is at least 1. Copy the query output into `artifacts/` before `down`.

## Gotchas

- Marks are SVG over an `img` inside `patch-canvas`; click the image, not the header.
- Empty submit is allowed and still increments `done_count`.
- `down` deletes the verify SQLite; export counts first.
