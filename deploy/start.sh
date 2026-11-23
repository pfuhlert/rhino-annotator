#!/bin/bash

# Usage example: ./start.sh

# load dotenv file
source .env
export APPNAME
export APPVERSION
export REMOTE_REGISTRY
export NAMESPACE

echo "Starting docker image '$APPNAME:$APPVERSION' ..."
echo "Pulling image from remote registry '$REMOTE_REGISTRY'..."

echo "Deploying StatefulSet to Kubernetes cluster..."
((envsubst < statefulset.yaml) | kubectl apply -f -) && echo "StatefulSet succeeded" || { echo "StatefulSet failed"; exit 1; }

kubectl rollout restart statefulset/$APPNAME -n $NAMESPACE && echo "Rollout restart succeeded" || { echo "Rollout restart failed"; exit 1; }
