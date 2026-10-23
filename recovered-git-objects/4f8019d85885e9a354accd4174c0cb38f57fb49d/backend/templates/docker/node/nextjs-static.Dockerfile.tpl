FROM node:22-alpine3.21 AS deps
WORKDIR /app
COPY . .
RUN {{INSTALL_COMMAND}}

FROM node:22-alpine3.21 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
{{BUILD_ENV_DECLARATIONS}}
RUN {{BUILD_COMMAND}}

FROM nginx:1.27-alpine AS runner
COPY --from=builder /app/{{OUTPUT_DIRECTORY}} /usr/share/nginx/html
EXPOSE 80
