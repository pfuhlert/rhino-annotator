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

```bash
sqlite3 "$(./scripts/verify-simple-annotator sqlite)" 'select count(*) from annotations;'
./scripts/verify-simple-annotator browser \
  goto --path /annotate \
  wait --testid annotate-app \
  click --testid next \
  snapshot --out .cursor/skills/verify-simple-annotator/artifacts/skip-after.aria.txt
sqlite3 "$(./scripts/verify-simple-annotator sqlite)" 'select count(*) from annotations; select count(*) from patch_visits;'
```

Copy both query outputs into `artifacts/` before `down`.

- **Proof.** `annotate-app` remains. Annotation count is unchanged versus just before next. A `patch_visits` row exists for the new crop.

## Gotchas

- Next still keeps the sticky job unless the user also changed the switcher.
- Do not treat a new placeholder image alone as proof; read SQLite.
- There is no `skips` table; skip is just next without marks.
