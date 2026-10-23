FROM python:3.11-slim AS builder
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
COPY . .
RUN {{INSTALL_COMMAND}}

FROM python:3.11-slim AS runner
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
RUN useradd --create-home --shell /usr/sbin/nologin appuser
COPY --from=builder /usr/local /usr/local
COPY . .
USER appuser
EXPOSE {{EXPECTED_PORT}}
CMD {{START_COMMAND_JSON}}
