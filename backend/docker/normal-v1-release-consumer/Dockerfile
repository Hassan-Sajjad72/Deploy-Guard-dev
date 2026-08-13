FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      docker.io \
      git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/backend
