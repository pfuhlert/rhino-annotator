# <img src="frontend/src/app/icon.svg" width="36" align="top" alt=""> Rhino Annotator

Web app for annotating EM and histology images from Girder: draw masks (with AI-assisted point and box segmentation, SAM / μSAM) and score images from 0 to 100. Next.js frontend in `frontend/`, FastAPI backend and GPU AI worker in `backend/`, data in SQLite.

Based on [JustAnnotate](https://github.com/dschaub95/simple-annotator) and the slider scoring of [TEM Scorer](https://github.com/dschaub95/tem-scorer), both by Darius Schaub.

## Mask and score classes

Each label class in a project is either a **mask** class, drawn on the image as polygons, brush strokes or points, or a **score** class, which gives each image one value from 0 to 100, or marks it not scorable. Add them in the project settings with **+ Mask** or **+ Score**; a project can mix both. An existing class keeps its mode in every project.

Score classes show a slider dock above the toolbar. Keys: `0`–`9` score in tens and two digits typed quickly give any value (`9 5` → 95, `1 0` → 100), `X` marks the image not scorable, `S` / `Shift+S` switch between score classes, `Enter` / `Shift+Enter` go to the next / previous image. Scores save immediately, are shared like annotations in shared projects, and appear in the CSV export as rows of type `score` with a `score` column (empty = not scorable).

## Run it

For the long-lived pod in the `rhino` Kubernetes namespace, follow [deploy/README.md](deploy/README.md). The steps below run it on any machine with Node and uv.

Put Girder settings in `.env` at the repo root:

```bash
GIRDER_API_URL=https://rhinodb.ims.bio/api/v1
GIRDER_TOKEN=<your Girder API key>
```

Without `GIRDER_TOKEN`, the app serves a placeholder image. Requirements: Node 20.9+ and [uv](https://docs.astral.sh/uv/) (it installs Python 3.12 itself).

```bash
npm install --prefix frontend
RHINO_ANNOTATOR_AI=0 npm run dev    # API on :8000, web on :3000
```

Open <http://localhost:3000> and register. `RHINO_ANNOTATOR_AI=0` runs without the GPU worker; leave it out on a machine with a GPU to get AI segmentation (the SAM models download on first start). See [docs/ai-annotation.md](docs/ai-annotation.md) for AI details and [AGENTS.md](AGENTS.md) for checks and Python environment rules.

### In a temporary Kubernetes pod

A throwaway pod is deleted on `exit`, with everything in it, including annotations and scores. Good for a demo or screenshots; use a pod with persistent storage for real work.

```bash
kubectl run rhino-annotator -n <namespace> --rm -it --restart=Never --image=node:22-bookworm -- bash
```

In the pod:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh && export PATH=$HOME/.local/bin:$PATH
git clone https://github.com/pfuhlert/rhino-annotator /app && cd /app
printf 'GIRDER_API_URL=https://rhinodb.ims.bio/api/v1\nGIRDER_TOKEN=<your Girder API key>\n' > .env
npm install --prefix frontend
RHINO_ANNOTATOR_AI=0 npm run dev
```

On your laptop, forward only the web port (it passes API requests on to the backend inside the pod):

```bash
kubectl port-forward -n <namespace> pod/rhino-annotator 3000:3000
```

Then open <http://localhost:3000>.

## Long-running instance

`scripts/prod` runs a long-lived copy beside `npm run dev`, so you can keep developing while others annotate. It lives on the persistent disk beside the checkout, so its data survives pod rebuilds.

| | Dev | Prod |
| --- | --- | --- |
| Code | this checkout | `../rhino-annotator-prod/app` (git worktree, pinned commit) |
| Database | `backend/data/annotator.sqlite` | `../rhino-annotator-prod/data/annotator.sqlite` |
| Ports | 3000 / 8000 | 3300 / 8300 |

```bash
npm run prod -- deploy          # deploy main: stop, back up DB, check out, install, build, start
npm run prod -- deploy <sha>    # deploy or roll back to any local commit
npm run prod -- status | logs | start | stop | restart
```

Prod reads `../rhino-annotator-prod/.env`, copied from the repo `.env` on first deploy. Only committed code is deployed; a failed deploy rolls back. Database backups go to `../rhino-annotator-prod/data/backups/` (last 5). Set `RHINO_ANNOTATOR_PROD_DIR` to move it. After a pod restart, run `npm run prod -- start`. Open it from a laptop with `kubectl port-forward -n <namespace> pod/<your-pod> 3300:3300`.
