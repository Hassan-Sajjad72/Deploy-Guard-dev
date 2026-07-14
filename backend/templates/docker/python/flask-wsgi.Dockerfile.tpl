FROM python:3.11-slim AS builder
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
COPY . .
RUN {{INSTALL_COMMAND}}

FROM python:3.11-slim AS runner
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PATH="/opt/venv/bin:$PATH"
RUN useradd --create-home --shell /usr/sbin/nologin appuser
COPY --from=builder /opt/venv /opt/venv
COPY --chown=appuser:appuser . .
USER appuser
EXPOSE {{EXPECTED_PORT}}
CMD {{START_COMMAND_JSON}}
