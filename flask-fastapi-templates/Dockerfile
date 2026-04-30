FROM python:3.11-alpine

WORKDIR /app

# Install system deps (for packages like cryptography, etc.)
RUN apk add --no-cache gcc musl-dev libffi-dev

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy app
COPY . .

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# Standardize port (avoid template errors)
EXPOSE 8000

# Dynamic start command injected by backend
CMD ["sh", "-c", "${START_CMD}"]