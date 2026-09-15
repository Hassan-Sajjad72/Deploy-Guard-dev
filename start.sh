#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/runtime-lib.sh"

verify_docker
validate_base_env
compose config -q || fail "Compose configuration validation failed."

printf '%s\n' 'Pulling exact pinned runtime images...'
while IFS= read -r image; do
  # A normal restart can be performed offline when the same fixed image already
  # exists locally. A clean laptop always pulls this exact image reference.
  if docker image inspect "$image" >/dev/null 2>&1; then
    printf 'Using local pinned image: %s\n' "$image"
  else
    docker pull "$image" || fail "Unable to pull $image. Confirm GHCR package visibility and image tags."
  fi
done < <(compose config --images)

printf '%s\n' 'Starting PostgreSQL...'
compose up -d postgres
wait_for_health postgres 120

printf '%s\n' 'Running database migrations...'
compose rm -sf migrate >/dev/null 2>&1 || true
compose up --no-deps --force-recreate migrate || fail "Database migration service failed."
wait_for_migration

printf '%s\n' 'Starting DeployGuard backend...'
compose up -d --no-deps backend
wait_for_health backend 180

printf '%s\n' 'Starting DeployGuard frontend...'
compose up -d --no-deps frontend
wait_for_health frontend 120

printf '%s\n' 'Starting Prometheus...'
compose up -d --no-deps prometheus
wait_for_health prometheus 120

printf '%s\n' 'Starting Grafana...'
compose up -d --no-deps grafana
wait_for_health grafana 180

"$RUNTIME_DIR/healthcheck.sh"
"$RUNTIME_DIR/status.sh"
printf '\nDeployGuard team runtime is ready:\n'
printf '  Frontend:   http://localhost:%s\n' "$(env_value FRONTEND_HOST_PORT)"
printf '  Backend:    http://localhost:%s\n' "$(env_value BACKEND_HOST_PORT)"
printf '  Prometheus: http://localhost:%s\n' "$(env_value PROMETHEUS_HOST_PORT)"
printf '  Grafana:    http://localhost:%s\n' "$(env_value GRAFANA_HOST_PORT)"
