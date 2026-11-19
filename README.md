# <img src="frontend/src/app/icon.svg" width="36" align="top" alt=""> Rhino Annotator

Web app for annotating EM and histology images from Girder: draw masks (with AI-assisted point and box segmentation, SAM / μSAM) and score images from 0 to 100. Next.js frontend in `frontend/`, FastAPI backend and GPU AI worker in `backend/`, data in SQLite.

Based on [JustAnnotate](https://github.com/dschaub95/simple-annotator) and the slider scoring of [TEM Scorer](https://github.com/dschaub95/tem-scorer), both by Darius Schaub.

## Mask and score classes

Each label class in a project is either a **mask** class, drawn on the image as polygons, brush strokes or points, or a **score** class, which gives each image one value from 0 to 100, or marks it not scorable. Add them in the project settings with **+ Mask** or **+ Score**; a project can mix both. An existing class keeps its mode in every project.

Score classes show a slider dock above the toolbar. Keys: `0`–`9` score in tens and two digits typed quickly give any value (`9 5` → 95, `1 0` → 100), `X` marks the image not scorable, `S` / `Shift+S` switch between score classes, `Enter` / `Shift+Enter` go to the next / previous image. Scores save immediately, are shared like annotations in shared projects, and appear in the CSV export as rows of type `score` with a `score` column (empty = not scorable).

## Development

Put Girder settings in `.env` at the repo root:

```bash
GIRDER_API_URL=https://rhinodb.ims.bio/api/v1
GIRDER_TOKEN=...
GIRDER_FOLDER_ID=...
```

Without `GIRDER_TOKEN`, the app serves placeholder images.

```bash
npm run dev    # API on :8000, AI worker, web on :3000
```

Set `SIMPLE_ANNOTATOR_AI=0` to run without the GPU worker. See [docs/ai-annotation.md](docs/ai-annotation.md) for AI details and [AGENTS.md](AGENTS.md) for checks and Python environment rules.

## Prod instance

`scripts/prod` runs a long-lived copy beside `npm run dev`, so you can keep developing while others annotate.

| | Dev | Prod |
| --- | --- | --- |
| Code | this checkout | `../simple-annotator-prod/app` (git worktree, pinned commit) |
| Database | `backend/data/annotator.sqlite` | `../simple-annotator-prod/data/annotator.sqlite` |
| Venv | `~/.uv-local/venvs/simple-annotator` | `~/.uv-local/venvs/simple-annotator-prod` |
| Ports | 3000 / 8000 | 3300 / 8300 |

Prod reads `../simple-annotator-prod/.env`, which is copied from the repo `.env` on first deploy. Variables set in the shell override it.

```bash
npm run prod -- deploy          # deploy main: stop, back up DB, check out, install, build, start
npm run prod -- deploy <sha>    # deploy or roll back to any local commit
npm run prod -- status | logs | start | stop | restart
```

Only committed code is deployed. A failed deploy rolls back to the previous commit, and `status` shows the failure. Database backups go to `../simple-annotator-prod/data/backups/` (last 5). Prod lives beside this checkout on the persistent disk, not in `$HOME`, so its data survives pod rebuilds; set `SIMPLE_ANNOTATOR_PROD_DIR` to move it. Nothing restarts the processes after a pod restart; run `npm run prod -- start`, which also rebuilds the venv if it is gone.

To deploy automatically after each successful push to `main`, install the hook once:

```bash
ln -s ../../scripts/hooks/reference-transaction .git/hooks/reference-transaction
```

The push waits for the deploy (about 20 s) and prints the result. Full output goes to `../simple-annotator-prod/logs/deploy.log`. Because the hook watches `origin/main`, a fetch that brings new commits also deploys.

### Open prod from a laptop

With access to the `rhino` Kubernetes namespace:

```bash
kubectl port-forward -n rhino pod/statefulset-darius-0 3300:3300
```

Then open <http://localhost:3300> and register.
