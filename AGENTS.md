# Agent instructions

## Code conventions

- Keep code small and readable; avoid detailed docstrings unless asked.
- Keep `__init__.py` files empty unless explicitly asked to add something.
- Add or update tests for meaningful behavior and regressions; avoid tests that merely repeat the implementation.
- For frontend work, read [frontend/AGENTS.md](frontend/AGENTS.md). Next.js maintains that file.

## Python environment

- Run Python commands from `backend/`, always prefixed with `UV_CACHE_DIR=/tmp/uv-cache`.
- Check the workspace filesystem with `findmnt -T . -o FSTYPE -n`. On `nfs`, `nfs4`, or `ceph`, set `VIRTUAL_ENV=$HOME/.uv-local/venvs/rhino-annotator` and `UV_PROJECT_ENVIRONMENT=$VIRTUAL_ENV`, and use `uv run --active` instead of `uv run`. Use the same environment for `uv sync` / `uv lock`; do not create a project-local `.venv`. Otherwise use plain `uv run`.

## Validation

After code, dependency, or build configuration changes, run the checks for each affected part before finishing. Changes affecting both backend and frontend require both rows. Documentation-only changes do not require runtime checks.

| Part | Directory | Required checks |
| --- | --- | --- |
| Backend | `backend/` | `uv run ruff check . --fix`, `uv run ruff format .`, `uv run pytest` (apply the Python environment rules above) |
| Frontend | `frontend/` | `npm test`, `npm run lint`, `npm run typecheck` |

- For verification or debugging that needs the running app, use the [verify-rhino-annotator skill](.cursor/skills/verify-rhino-annotator/SKILL.md) to check affected behavior (UI, API integration, authentication, persistence, or startup) and capture evidence on its isolated stack. Leave existing dev servers untouched.
- Also run `npm run build` in `frontend/` when changes affect build configuration, dependencies, server/client boundaries, or prerendering, or when requested.
- Fix failures caused by your changes and rerun affected checks. Once the required checks pass, repeat or broaden testing only for new changes, failures, or unresolved concerns.
- Report which checks passed and any failures or checks you could not run, with reasons. Do not claim verification that did not run.
