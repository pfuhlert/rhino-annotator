# Simple annotator verification map

This directory is the maintained source for verifying user-facing behavior. Read this index before driving the app, then use the matching feature file.

## Baseline preconditions

- A developer `npm run dev` on 3000/8000 may already be running. That session is off-limits.
- Launch an isolated stack with `./scripts/verify-simple-annotator up`.
- Run `./scripts/verify-simple-annotator doctor` and require `ok: true` and `ownsDefaultDevPorts: false`.
- Drive only `$(./scripts/verify-simple-annotator url)`.
- Crops are placeholders (`GIRDER_TOKEN` unset).
- Never drive an instance this run did not start.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Prefer `data-testid` handles listed in the skill.
- Treat helper commands as literal.
- After a mutation, confirm with a second view (`/me` or SQLite), not only the screenshot.
- `down` may delete the verify SQLite. Copy any DB proof into `artifacts/` first.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes an ARIA snapshot and a screenshot with the annotate or login chrome visible.
- Mutation proof includes `/me` JSON or a SQLite read of the verify file.
- Record the feature file used with every artifact.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 and one paragraph, then exactly four H2 sections: `Sub-features`, `How to get to it (user POV)`, `Driving it with Playwright`, `Gotchas`.

## Features

- [Login](./login.md) covers register, login, session, and landing on annotate.
- [Switch job](./switch-job.md) covers changing the job on a patch and sticky `last_job_id`.
- [Annotate and next](./annotate-submit.md) covers point, polygon, and an `annotations` row.
- [Next without marks](./skip-patch.md) covers Next advancing without an annotation row.
