FROM hashicorp/terraform:1.10.5 AS terraform

FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=terraform /bin/terraform /usr/local/bin/terraform

WORKDIR /workspace/backend
