# -------- BUILDER --------
FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN npm run build


# -------- RUNTIME --------
FROM nginx:alpine

# Copy static files to nginx
COPY --from=builder /app/dist /usr/share/nginx/html

# nginx runs automatically