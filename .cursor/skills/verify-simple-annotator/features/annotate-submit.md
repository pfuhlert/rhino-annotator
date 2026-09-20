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

```bash
./scripts/verify-simple-annotator browser \
  goto --path /annotate \
  wait --testid annotate-app \
  select --testid tool-switcher --option tool-point \
  click --testid patch-canvas --at 180,180 \
  screenshot --out .cursor/skills/verify-simple-annotator/artifacts/mark.png \
  click --testid next \
  snapshot --out .cursor/skills/verify-simple-annotator/artifacts/mark-after.aria.txt
```

Polygon: `select --testid tool-switcher --option tool-polygon` then `drag --testid patch-canvas --from 80,80 --to 220,160`. Brush: `tool-brush` and the same `drag` (`--shift` erases).

- **Proof.** Screenshot after marks and after next. `sqlite3 $(./scripts/verify-simple-annotator sqlite) 'select count(*) from annotations;'` is at least 1. Copy the query output into `artifacts/` before `down`.

## Gotchas

- Marks are a canvas overlay on an `img` inside `patch-canvas`; click `--at` the image, not the header.
- Empty next is allowed and does not increment `done_count`.
- `down` deletes the verify SQLite; export counts first.
