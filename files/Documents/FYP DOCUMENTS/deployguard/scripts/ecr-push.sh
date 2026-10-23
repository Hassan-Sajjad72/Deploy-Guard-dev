#!/usr/bin/env bash
set -euo pipefail
command -v docker >/dev/null 2>&1 || { echo "Docker required"; exit 1; }
command -v aws    >/dev/null 2>&1 || { echo "AWS CLI required"; exit 1; }

AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGISTRY="$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com"
TAG="${IMAGE_TAG:-latest}"

echo "[INFO] Logging in to ECR..."
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY"

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "[INFO] Building & pushing backend..."
docker build -t "$REGISTRY/deployguard-app:$TAG" ./backend
docker push "$REGISTRY/deployguard-app:$TAG"

echo "[INFO] Building & pushing frontend..."
docker build -t "$REGISTRY/deployguard-app:frontend-$TAG" ./frontend
docker push "$REGISTRY/deployguard-app:frontend-$TAG"

echo "[INFO] Done!"
