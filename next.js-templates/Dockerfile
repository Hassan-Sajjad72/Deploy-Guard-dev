# -------- BUILDER --------
FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN npm run build


# -------- RUNTIME --------
FROM node:18-alpine

WORKDIR /app

# Copy required runtime files only
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public

RUN npm install --omit=dev

CMD ["npm", "start"]