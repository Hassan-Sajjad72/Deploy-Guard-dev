# -------- BUILDER --------
FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .


# -------- RUNTIME --------
FROM node:18-alpine

WORKDIR /app

# Copy only necessary files
COPY --from=builder /app ./

# Remove dev dependencies
RUN npm prune --omit=dev

# Run app
CMD ["node", "index.js"]