# Deploy

A long-lived pod for Rhino Annotator, built like our other project pods: an image with Node, uv and
zsh, a StatefulSet that keeps the pod (and its volumes) across restarts, and the app started inside it.

## 1. Settings

Add a `.env` file in this folder (it is git-ignored):

```
APPNAME=rhino-annotator
APPVERSION=0.1.0
REMOTE_REGISTRY=cr.ims.bio/imsb
NAMESPACE=rhino
```

The pod mounts only one folder of the shared rhino volume (`pvc-rhino-shared`): `rhino-annotator/`,
at `/data/rhino/rhino-annotator`. The code, the annotation database and its backups all live there,
so they survive pod restarts; nothing else on the shared volume is visible to the pod.

Create the folder once from a pod that has the whole volume, e.g. `rhino-0`, so it belongs to you
(Kubernetes would otherwise create it owned by root, and the app could not write to it):

```bash
mkdir /data/rhino/rhino-annotator
```

## 2. Build and push the image

Login to the remote registry before building: `podman login cr.ims.bio`

```bash
./build.sh
```

## 3. Start the pod

```bash
./start.sh
```

The pod is `rhino-annotator-0`. It asks for 1 CPU and 8Gi of memory and no GPU, so the app runs
without AI segmentation; drawing masks and scoring work as usual. Wait until it is `Running`:

```bash
kubectl get pod -n rhino rhino-annotator-0 -w
```

## 4. Start the app inside the pod

```bash
kubectl exec -it -n rhino rhino-annotator-0 -- zsh
```

Clone the repo into the mounted folder and add the Girder settings:

```bash
cd /data/rhino/rhino-annotator
git clone https://github.com/pfuhlert/rhino-annotator code && cd code
printf 'GIRDER_API_URL=https://rhinodb.ims.bio/api/v1\nGIRDER_TOKEN=<your Girder API key>\nSIMPLE_ANNOTATOR_AI=0\n' > .env
```

Start the long-running instance (frontend build, API and web app):

```bash
npm run prod -- deploy
```

It runs on ports 3300 (web) and 8300 (API) and keeps its database in
`/data/rhino/rhino-annotator/simple-annotator-prod/data/`. Check it with `npm run prod -- status` and
`npm run prod -- logs`. To update, `git pull` and run `npm run prod -- deploy` again. After the pod
restarts, run `npm run prod -- start` again.

## 5. Open it from a laptop

```bash
kubectl port-forward -n rhino rhino-annotator-0 3300:3300
```

Then open <http://localhost:3300> and register.

## Remove it

```bash
kubectl delete statefulset rhino-annotator -n rhino
```

The folder on the shared volume, with the code and database, is kept.
