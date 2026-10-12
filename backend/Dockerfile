FROM node:22.14.0-bookworm-slim AS dependencies
WORKDIR /build
COPY backend/package.json backend/package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY backend/nest-cli.json backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build

FROM node:22.14.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/backend

RUN apt-get update \
    && apt-get install -y --no-install-recommends awscli ca-certificates curl git openssh-client unzip \
    && rm -rf /var/lib/apt/lists/*

# Hosting-profile execution (EC2, Lightsail, Lambda, static) runs the pinned Terraform 1.10.5 in the control plane.
# shortcut: linux_amd64 only; add the arm64 archive and checksum before building arm64 images.
RUN curl -fsSLo /tmp/terraform.zip https://releases.hashicorp.com/terraform/1.10.5/terraform_1.10.5_linux_amd64.zip \
    && echo "0566a24f5332098b15716ebc394be503f4094acba5ba529bf5eb0698ed5e2a90  /tmp/terraform.zip" | sha256sum -c - \
    && unzip -q /tmp/terraform.zip terraform -d /usr/local/bin \
    && rm /tmp/terraform.zip

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /build/dist ./dist
COPY backend/terraform ./terraform
COPY .github/workflows/deployguard-reusable.yml /app/.github/workflows/deployguard-reusable.yml
COPY infrastructure/railpack-runtime/main.tf /app/infrastructure/railpack-runtime/main.tf
COPY infrastructure/railpack-runtime/variables.tf /app/infrastructure/railpack-runtime/variables.tf
COPY infrastructure/railpack-runtime/outputs.tf /app/infrastructure/railpack-runtime/outputs.tf
COPY infrastructure/railpack-runtime/.terraform.lock.hcl /app/infrastructure/railpack-runtime/.terraform.lock.hcl
COPY infrastructure/hosting-profiles /app/infrastructure/hosting-profiles
# The executable fingerprint hashes these sources so provider proofs verify identically in every runtime.
COPY backend/src/planning/hosting-provider-session.service.ts backend/src/planning/hosting-provider-adapter.service.ts backend/src/planning/hosting-profile-inputs.ts ./src/planning/

RUN mkdir -p /app/backend/.deployguard/terraform-workspaces \
    && chown -R node:node /app

USER node
EXPOSE 5000
CMD ["node", "dist/src/main.js"]
