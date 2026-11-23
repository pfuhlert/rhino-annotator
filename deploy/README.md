# Deploy

How to run Rhino Annotator as a long-lived pod in the `rhino` namespace: an image with Node, uv and
zsh, a StatefulSet that brings the pod back after restarts, and the app started inside it with
`npm run prod`.

Steps 1–3 run on your laptop (needs `kubectl`, `podman` and `envsubst`), steps 4–6 inside the pod.

## 1. Settings

Add a `.env` file in this folder (it is git-ignored):

```
APPNAME=rhino-annotator
APPVERSION=0.1.0
REMOTE_REGISTRY=cr.ims.bio/imsb
NAMESPACE=rhino
```

The pod sees only one folder of the shared rhino volume (`pvc-rhino-shared`, CephFS):
`rhino-annotator/`, mounted at `/data/rhino/rhino-annotator`. The code, the annotation database and
its backups all live there, so they survive pod restarts.

Create that folder once, before the first start, from a pod that has the whole volume (`rhino-0`),
so it belongs to you. Otherwise Kubernetes creates it owned by root and the app cannot write to it:

```bash
kubectl exec -n rhino rhino-0 -- mkdir -p /data/rhino/rhino-annotator
```

## 2. Build and push the image

Only needed once, and again when `Dockerfile` or `requirements.apt` change. Log in first:

```bash
podman login cr.ims.bio
```

```bash
./build.sh
```

## 3. Start the pod

```bash
./start.sh
```

```bash
kubectl get pod -n rhino rhino-annotator-0 -o wide -w
```

Wait until it is `Running`. The pod asks for 1 CPU and 8Gi of memory and no GPU, so the app runs
without AI segmentation; drawing masks and scoring work as usual.

`statefulset.yaml` keeps the pod off the node `puma`, where the shared volume's attachment was stuck
being deleted (`AttachVolume.Attach failed for volume "pv-rhino-shared" : volume attachment is being
deleted`). Once that is fixed, the `affinity` block can go.

## 4. Set up the app inside the pod

```bash
kubectl exec -it -n rhino rhino-annotator-0 -- zsh
```

Check the tools and that the folder is writable:

```bash
node -v && npm -v && uv --version
```

```bash
cd /data/rhino/rhino-annotator && touch .write-test && rm .write-test && echo writable
```

Clone the repo (GitHub username, and a personal access token as the password):

```bash
git clone https://github.com/pfuhlert/rhino-annotator code && cd code
```

Add the Girder settings. Inside the cluster, Girder is reachable directly at `girder:8080`; the
`http://` is required:

```bash
printf 'GIRDER_API_URL=http://girder:8080/api/v1\nGIRDER_TOKEN=<your Girder API key>\nSIMPLE_ANNOTATOR_AI=0\n' > .env
```

Check that Girder answers and accepts the key. `--noproxy` skips the institute proxy from
`proxy-config`, which cannot reach cluster names; the app's backend does the same on its own:

```bash
curl -sS -m 10 --noproxy '*' http://girder:8080/api/v1/system/version
```

```bash
curl -sS -m 10 --noproxy '*' -H "Girder-Token: $(grep ^GIRDER_TOKEN= .env | cut -d= -f2)" http://girder:8080/api/v1/user/me
```

The first prints Girder's version, the second your Girder user. `null` means the key is not valid on
this server.

## 5. Start the app

In `/data/rhino/rhino-annotator/code`:

```bash
npm run prod -- deploy
```

The first run takes a few minutes: it installs Python 3.12 and the backend packages, installs and
builds the frontend, and starts the API (port 8300) and the web app (port 3300). Check it:

```bash
npm run prod -- status
```

```bash
npm run prod -- logs
```

## 6. Open it from a laptop

```bash
kubectl port-forward -n rhino rhino-annotator-0 3300:3300
```

Open <http://localhost:3300> and register. Click the project name at the top left, then
**New project**: add a Girder folder and classes with **+ Mask** or **+ Score**.

## Day to day

All in the pod, in `/data/rhino/rhino-annotator/code`:

| Task | Command |
| --- | --- |
| Update to the latest code | `git pull && npm run prod -- deploy` |
| After the pod restarted | `npm run prod -- start` |
| Restart the app | `npm run prod -- restart` |
| Stop the app | `npm run prod -- stop` |
| Is it running? | `npm run prod -- status` |
| What went wrong? | `npm run prod -- logs` |

The app does not start by itself when the pod restarts; run `npm run prod -- start`.

### Settings live in two places

`npm run prod` copies `code/.env` to `/data/rhino/rhino-annotator/simple-annotator-prod/.env` on the
first `deploy` and uses that copy from then on. To change a setting later (Girder address, token),
edit `../simple-annotator-prod/.env` (and `code/.env`, to keep them the same), then
`npm run prod -- restart`.

### Data

| What | Where |
| --- | --- |
| Database | `/data/rhino/rhino-annotator/simple-annotator-prod/data/annotator.sqlite` |
| Backups (last 5, one per deploy) | `/data/rhino/rhino-annotator/simple-annotator-prod/data/backups/` |
| Logs | `/data/rhino/rhino-annotator/simple-annotator-prod/logs/` |

The CSV export (download button at the bottom of the sidebar) has every annotation and score of a
project.

## Troubleshooting

- **Pod stays `Pending`:** `kubectl describe pod -n rhino rhino-annotator-0 | tail -20`. "exceeded
  quota" means the namespace has no room left; "Insufficient cpu/memory" means no node has room.
- **`AttachVolume.Attach failed ... volume attachment is being deleted`:** the shared volume's
  attachment on that node is stuck; keep the pod off that node (see step 3) and tell the cluster
  admin. Do not delete the VolumeAttachment yourself: other pods use the same volume.
- **`Permission denied` in `/data/rhino/rhino-annotator`:** the folder was created by Kubernetes,
  owned by root. Ask the cluster admin to hand it to uid 2828.
- **No folders or images in the app:** check `GIRDER_API_URL` (with `http://`) and the token in
  `../simple-annotator-prod/.env`, and the two `curl` checks in step 4.

## Remove it

```bash
kubectl delete statefulset rhino-annotator -n rhino
```

The folder on the shared volume, with the code and the database, is kept.
