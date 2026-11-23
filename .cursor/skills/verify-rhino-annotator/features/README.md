# Rhino Annotator verification map

This directory is the maintained source for verifying user-facing behavior. Read this index before driving the app, then use the matching feature file.

## Baseline preconditions

- Use only `./scripts/verify-rhino-annotator`. Cursor browser tools cannot see this host on Kubernetes.
- `npm run dev` on 3000/8000 may be running. Leave it; do not stop or drive it.
- `doctor` / `login-proof` start a second stack if needed. Require `ok: true` and a `webUrl` that is not port 3000.
- Drive only `$(./scripts/verify-rhino-annotator url)`.
- The dataset is one placeholder image of 1024 × 1024 px, shown whole (`GIRDER_TOKEN` unset).
- Never drive an instance this run did not start.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Prefer `data-testid` handles listed in the skill.
- Treat helper commands as literal. One `browser` chain is one session; do not split a flow across invocations.
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
- [Annotate and next](./annotate-submit.md) covers Tab tool cycle, point, polygon, brush, and `elements` types.
- [Next without marks](./skip-patch.md) covers Next advancing without an annotation row.
- [Image list](./image-list.md) covers the Images tab, case groups, stain filter, opening an image, and list-order navigation.

- [AI annotation](./ai-annotation.md) covers the background GPU queue, local TEM fixtures, and normal annotation editing.
