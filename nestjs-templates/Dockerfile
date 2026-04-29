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

# Copy only runtime essentials
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist

RUN npm install --omit=dev

CMD ["node", "dist/main.js"]