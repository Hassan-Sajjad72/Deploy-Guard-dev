FROM node:22.14.0-bookworm-slim AS dependencies
WORKDIR /build
COPY backend/package.json backend/package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY backend/nest-cli.json backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

FROM hashicorp/terraform:1.10.5 AS terraform
FROM docker:27.5.1-cli AS docker-cli

FROM node:22.14.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/backend
ARG TARGETARCH

RUN apt-get update \
    && apt-get install -y --no-install-recommends awscli ca-certificates curl git openssh-client \
    && rm -rf /var/lib/apt/lists/*

# DeployGuard invokes Terraform, AWS CLI, Git/SSH, curl, and the Docker client
# while handling real deployment operations.  Terraform is copied from its
# versioned upstream image so this runtime remains portable across Buildx
# target architectures without relying on a host Terraform installation.
COPY --from=terraform /bin/terraform /usr/local/bin/terraform
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
RUN case "$TARGETARCH" in amd64|arm64) infracost_arch="$TARGETARCH" ;; *) echo "Unsupported Infracost architecture: $TARGETARCH" >&2; exit 1 ;; esac \
    && curl -fsSL "https://github.com/infracost/infracost/releases/download/v0.10.43/infracost-linux-${infracost_arch}.tar.gz" \
      | tar -xz -C /usr/local/bin \
    && mv "/usr/local/bin/infracost-linux-${infracost_arch}" /usr/local/bin/infracost \
    && chmod 0755 /usr/local/bin/infracost

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /build/dist ./dist
COPY backend/terraform ./terraform
COPY .github/workflows/deployguard-reusable.yml /app/.github/workflows/deployguard-reusable.yml
COPY infrastructure/railpack-runtime/main.tf /app/infrastructure/railpack-runtime/main.tf
COPY infrastructure/railpack-runtime/variables.tf /app/infrastructure/railpack-runtime/variables.tf
COPY infrastructure/railpack-runtime/outputs.tf /app/infrastructure/railpack-runtime/outputs.tf

RUN mkdir -p /app/backend/.deployguard/terraform-workspaces \
    && chown -R node:node /app

USER node
EXPOSE 5000
CMD ["node", "dist/src/main.js"]
