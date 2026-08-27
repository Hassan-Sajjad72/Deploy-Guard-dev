FROM {{BUILD_BASE_IMAGE}} AS deps
{{BUILD_SYSTEM_DEPENDENCIES}}
WORKDIR /app
COPY . .
RUN {{INSTALL_COMMAND}}
{{BUILD_STEP}}
RUN {{PRUNE_COMMAND}}

FROM {{RUNTIME_BASE_IMAGE}} AS runner
{{RUNTIME_SYSTEM_DEPENDENCIES}}
WORKDIR /app
ENV NODE_ENV=production
LABEL io.deployguard.framework="{{FRAMEWORK}}" io.deployguard.framework-mode="{{FRAMEWORK_MODE}}" io.deployguard.source-commit="{{COMMIT_SHA}}" io.deployguard.application-root="{{APP_ROOT}}" io.deployguard.install-root="{{REPOSITORY_INSTALL_ROOT}}" io.deployguard.runtime-files="{{RUNTIME_FILES}}" io.deployguard.health-path="{{HEALTH_CHECK_PATH}}"
RUN addgroup -S app && adduser -S app -G app && chown app:app /app
COPY --from=deps --chown=app:app /app ./
USER app
EXPOSE {{EXPECTED_PORT}}
CMD {{START_COMMAND_JSON}}
