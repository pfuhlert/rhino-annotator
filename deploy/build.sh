#!/bin/bash

# Usage example: ./build.sh

# load dotenv file
source .env
echo "Building docker image '$APPNAME:$APPVERSION' ..."

echo "Starting to build and deploy '$APPNAME:$APPVERSION' docker image to '$REMOTE_REGISTRY'..."

IMAGE_TAG="$REMOTE_REGISTRY/$APPNAME:$APPVERSION"

podman build -t $IMAGE_TAG -f Dockerfile . && echo "Build succeeded" || { echo "Build failed"; exit 1; }

# podman tag localhost/$APPNAME:$APPVERSION $REMOTE_REGISTRY/$APPNAME:$APPVERSION
echo "Pushing to remote registry '$REMOTE_REGISTRY'..."

podman login $REMOTE_REGISTRY

podman push $IMAGE_TAG && echo "Push succeeded" || { echo "Push failed"; exit 1; }

echo "Docker image '$IMAGE_TAG' successfully built and pushed."
