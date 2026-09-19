# Next without marks

Next advances to the next crop. With no marks, no annotation row is written.

## Sub-features

- `next-advance` replaces the current crop.
- `next-no-annotation` leaves `annotations` unchanged.
- `prev-back` returns to the previous crop via `prev`.

## How to get to it (user POV)

- On `/annotate`, choose Next (N) or Previous (B).

## Driving it with Playwright

Preconditions:

- Isolated stack is healthy and a user is on `/annotate`.

- **Next.** Click `next` with no marks.
- **Proof.** `annotate-app` remains. `sqlite3 $(./scripts/verify-simple-annotator sqlite) 'select count(*) from annotations;'` is unchanged versus just before next. A `patch_visits` row exists for the new crop. Save those counts under `artifacts/` before `down`.

## Gotchas

- Next still keeps the sticky job unless the user also changed the switcher.
- Do not treat a new placeholder image alone as proof; read SQLite.
- There is no `skips` table; skip is just next without marks.
