FROM node:20-alpine AS deps
WORKDIR /app
COPY . .
RUN {{INSTALL_COMMAND}}

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN {{BUILD_COMMAND}}

FROM nginx:1.27-alpine AS runner
COPY --from=builder /app/out /usr/share/nginx/html
EXPOSE {{EXPECTED_PORT}}
