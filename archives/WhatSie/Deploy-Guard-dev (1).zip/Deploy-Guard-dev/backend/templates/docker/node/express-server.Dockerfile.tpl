FROM node:20-alpine AS deps
WORKDIR /app
COPY . .
RUN {{INSTALL_COMMAND}}

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
USER app
EXPOSE {{EXPECTED_PORT}}
CMD {{START_COMMAND_JSON}}
