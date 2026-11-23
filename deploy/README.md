# Deploy

A long-lived pod for Rhino Annotator, built like our other project pods: a GPU image with Node, uv and
zsh, a StatefulSet that keeps the pod (and its volumes) across restarts, and the app started inside it.

## 1. Settings

Add a `.env` file in this folder (it is git-ignored):

```
APPNAME=rhino-annotator
APPVERSION=0.1.0
REMOTE_REGISTRY=
NAMESPACE=imsb
```

`statefulset.yaml` mounts the same volumes as our other pods (`pvc-deltabonn-6`, `pvc-imsb-bonn-epyc`
and the `bonn-pe940` NFS share). PersistentVolumeClaims belong to one namespace, so in another
namespace change the volume claims to ones that exist there (`kubectl get pvc -n <namespace>`).

## 2. Build and push the image

Login to the remote registry before building: `podman login <registry>`

```bash
./build.sh
```

## 3. Start the pod

```bash
./start.sh
```

The pod is `${APPNAME}-0`, e.g. `rhino-annotator-0`.

## 4. Start the app inside the pod

```bash
kubectl exec -it -n imsb rhino-annotator-0 -- zsh
```

Clone the repo onto a mounted volume, so the code and the annotation database survive pod restarts:

```bash
mkdir -p /data/deltabonn-6/$USER && cd /data/deltabonn-6/$USER
git clone https://github.com/pfuhlert/rhino-annotator && cd rhino-annotator
printf 'GIRDER_API_URL=https://rhinodb.ims.bio/api/v1\nGIRDER_TOKEN=<your Girder API key>\n' > .env
```

Start the long-running instance (frontend build, API, web app and the GPU AI worker):

```bash
npm run prod -- deploy
```

It runs on ports 3300 (web) and 8300 (API) and keeps its database in
`../simple-annotator-prod/data/`. Check it with `npm run prod -- status` and `npm run prod -- logs`.
After the pod restarts, run `npm run prod -- start` again. To run without the GPU worker, put
`SIMPLE_ANNOTATOR_AI=0` in the `.env` file.

## 5. Open it from a laptop

```bash
kubectl port-forward -n imsb rhino-annotator-0 3300:3300
```

Then open <http://localhost:3300> and register.
