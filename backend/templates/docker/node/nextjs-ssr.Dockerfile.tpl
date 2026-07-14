FROM node:22-alpine3.21 AS deps
WORKDIR /app
COPY . .
RUN {{INSTALL_COMMAND}}

FROM node:22-alpine3.21 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN {{BUILD_COMMAND}}
RUN {{PRUNE_COMMAND}}

FROM node:22-alpine3.21 AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder --chown=app:app /app ./
USER app
EXPOSE {{EXPECTED_PORT}}
CMD {{START_COMMAND_JSON}}
