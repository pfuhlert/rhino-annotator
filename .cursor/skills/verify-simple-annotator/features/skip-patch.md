# Skip patch

Skip advances to the next crop without writing an annotation row.

## Sub-features

- `skip-advance` replaces the current crop.
- `skip-no-annotation` leaves `annotations` unchanged.
- `skip-row` inserts a `skips` row.

## How to get to it (user POV)

- On `/annotate`, choose Skip (S).

## Driving it with Playwright

Preconditions:

- Isolated stack is healthy and a user is on `/annotate`.

- **Skip.** Click `skip`.
- **Proof.** `annotate-app` remains. `sqlite3 $(./scripts/verify-simple-annotator sqlite) 'select count(*) from skips;'` is 1 and `select count(*) from annotations;'` is unchanged versus just before skip. Save those counts under `artifacts/` before `down`.

## Gotchas

- Skip still keeps the sticky job unless the user also changed the switcher.
- Do not treat a new placeholder image alone as proof; read SQLite.
