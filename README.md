# <img src="frontend/src/app/icon.svg" width="36" align="top" alt=""> JustAnnotate

Web app for annotating EM and histology images from Girder, with AI-assisted point and box segmentation (SAM / μSAM). Next.js frontend in `frontend/`, FastAPI backend and GPU AI worker in `backend/`, data in SQLite.

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
| Code | this checkout | `~/simple-annotator-prod/app` (git worktree, pinned commit) |
| Database | `backend/data/annotator.sqlite` | `~/simple-annotator-prod/data/annotator.sqlite` |
| Venv | `~/.uv-local/venvs/simple-annotator` | `~/.uv-local/venvs/simple-annotator-prod` |
| Ports | 3000 / 8000 | 3300 / 8300 |

Prod reads `~/simple-annotator-prod/.env`, which is copied from the repo `.env` on first deploy. Variables set in the shell override it.

```bash
npm run prod -- deploy          # deploy main: stop, back up DB, check out, install, build, start
npm run prod -- deploy <sha>    # deploy or roll back to any local commit
npm run prod -- status | logs | start | stop | restart
```

Only committed code is deployed. A failed deploy rolls back to the previous commit, and `status` shows the failure. Database backups go to `~/simple-annotator-prod/data/backups/` (last 5). Nothing restarts the processes after a pod restart; run `npm run prod -- start`.

To deploy automatically after each successful push to `main`, install the hook once:

```bash
ln -s ../../scripts/hooks/reference-transaction .git/hooks/reference-transaction
```

The push waits for the deploy (about 20 s) and prints the result. Full output goes to `~/simple-annotator-prod/logs/deploy.log`. Because the hook watches `origin/main`, a fetch that brings new commits also deploys.

### Open prod from a laptop

With access to the `rhino` Kubernetes namespace:

```bash
kubectl port-forward -n rhino pod/statefulset-darius-0 3300:3300
```

Then open <http://localhost:3300> and register.
