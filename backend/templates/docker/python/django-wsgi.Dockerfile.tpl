FROM {{BUILD_BASE_IMAGE}} AS builder
{{BUILD_SYSTEM_DEPENDENCIES}}
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
COPY . .
RUN {{INSTALL_COMMAND}}
WORKDIR {{APP_WORKDIR}}
{{BUILD_STEP}}

FROM {{RUNTIME_BASE_IMAGE}} AS runner
{{RUNTIME_SYSTEM_DEPENDENCIES}}
WORKDIR /app
LABEL io.deployguard.framework="{{FRAMEWORK}}" io.deployguard.framework-mode="{{FRAMEWORK_MODE}}" io.deployguard.source-commit="{{COMMIT_SHA}}" io.deployguard.application-root="{{APP_ROOT}}" io.deployguard.install-root="{{REPOSITORY_INSTALL_ROOT}}" io.deployguard.runtime-files="{{RUNTIME_FILES}}" io.deployguard.health-path="{{HEALTH_CHECK_PATH}}"
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PATH="/opt/venv/bin:$PATH"
RUN useradd --create-home --shell /usr/sbin/nologin appuser
COPY --from=builder /opt/venv /opt/venv
COPY --chown=appuser:appuser . /app
WORKDIR {{APP_WORKDIR}}
USER appuser
EXPOSE {{EXPECTED_PORT}}
CMD {{START_COMMAND_JSON}}
