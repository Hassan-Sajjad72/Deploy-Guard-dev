FROM {{BUILD_BASE_IMAGE}} AS deps
{{BUILD_SYSTEM_DEPENDENCIES}}
WORKDIR /app
COPY . .
RUN {{INSTALL_COMMAND}}

FROM {{BUILD_BASE_IMAGE}} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
{{BUILD_STEP}}

FROM {{RUNTIME_BASE_IMAGE}} AS runner
USER root
{{RUNTIME_SYSTEM_DEPENDENCIES}}
LABEL io.deployguard.framework="{{FRAMEWORK}}" io.deployguard.framework-mode="{{FRAMEWORK_MODE}}" io.deployguard.source-commit="{{COMMIT_SHA}}" io.deployguard.application-root="{{APP_ROOT}}" io.deployguard.install-root="{{REPOSITORY_INSTALL_ROOT}}" io.deployguard.runtime-files="{{RUNTIME_FILES}}" io.deployguard.health-path="{{HEALTH_CHECK_PATH}}"
COPY --from=builder /app/{{OUTPUT_DIRECTORY}} /usr/share/nginx/html
USER nginx
EXPOSE {{EXPECTED_PORT}}
