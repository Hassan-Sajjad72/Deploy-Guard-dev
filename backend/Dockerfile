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
    && apt-get install -y --no-install-recommends awscli ca-certificates curl git openssh-client \
    && rm -rf /var/lib/apt/lists/*

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /build/dist ./dist
COPY backend/templates ./templates
COPY backend/terraform ./terraform
COPY .github/workflows/deployguard-reusable.yml /app/.github/workflows/deployguard-reusable.yml

RUN mkdir -p /app/backend/.deployguard/terraform-workspaces \
    && chown -R node:node /app

USER node
EXPOSE 5000
CMD ["node", "dist/src/main.js"]
