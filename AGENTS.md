# Agent instructions

- For Python commands, always prefix with `UV_CACHE_DIR=/tmp/uv-cache`. Check the workspace filesystem with `findmnt -T . -o FSTYPE -n`; if the result is nfs, nfs4, or ceph, set `VIRTUAL_ENV=$HOME/.uv-local/venvs/simple-annotator` and `UV_PROJECT_ENVIRONMENT=$VIRTUAL_ENV`, use `uv run --active` from `backend/` (and the same env for `uv sync` / `uv lock`), and do not create a project-local `.venv`. Otherwise use plain `uv run`.
- After substantive backend changes, run `pytest`, `ruff format .`, and `ruff check . --fix` in `backend/` with that same Python prefix before finishing.
- Start the full app with root `npm run dev` (API on 8000, Next on 3000). Do not start frontend and backend in separate ad-hoc terminals unless debugging.
- Keep `__init__.py` files empty unless explicitly asked to add something.
- Keep the number of lines of code as small as possible while remaining readable.
- Do not write detailed docstrings unless asked.
- Only write tests that are actually useful.
