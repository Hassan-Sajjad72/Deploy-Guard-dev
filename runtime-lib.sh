#!/usr/bin/env bash
# Shared, host-dependency-free helpers.  Every probe runs through Docker.
set -Eeuo pipefail

RUNTIME_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE=(docker compose --env-file "$RUNTIME_DIR/.env" -f "$RUNTIME_DIR/compose.yaml")

compose() { "${COMPOSE[@]}" "$@"; }

fail() {
  printf '[FAIL] %s\n' "$*" >&2
  exit 1
}

require_runtime_env() {
  [ -f "$RUNTIME_DIR/.env" ] || fail "Missing .env. Create it with: cp .env.example .env"
}

env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$RUNTIME_DIR/.env" | tail -n 1
}

require_value() {
  local key="$1" value
  value="$(env_value "$key")"
  [ -n "$value" ] && [[ "$value" != CHANGE_ME* ]] && [[ "$value" != replace-with-* ]] || fail "Required .env value $key is empty or still a placeholder."
}

require_minimum_length() {
  local key="$1" minimum="$2" value
  require_value "$key"
  value="$(env_value "$key")"
  [ "${#value}" -ge "$minimum" ] || fail "$key must contain at least $minimum characters."
}

validate_base_env() {
  require_runtime_env
  require_value DEPLOYGUARD_BACKEND_IMAGE
  require_value DEPLOYGUARD_FRONTEND_IMAGE
  require_minimum_length POSTGRES_PASSWORD 16
  require_minimum_length JWT_SECRET 32
  require_minimum_length AUTH_SESSION_SECRET 32
  require_minimum_length SESSION_SECRET 32
  require_minimum_length PROMETHEUS_SCRAPE_TOKEN 32
  require_minimum_length GRAFANA_ADMIN_PASSWORD 16
}

verify_docker() {
  command -v docker >/dev/null 2>&1 || fail "Docker is not installed or not on PATH."
  docker info >/dev/null 2>&1 || fail "Docker is installed but its daemon is not reachable."
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is unavailable."
}

service_id() {
  compose ps -aq "$1" | tail -n 1
}

service_state() {
  docker inspect --format '{{.State.Status}}' "$1"
}

service_health() {
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1"
}

show_service_logs() {
  compose logs --tail=80 "$1" >&2 || true
}

wait_for_health() {
  local service="$1" timeout="${2:-120}" started="$(date +%s)" id state health
  while true; do
    id="$(service_id "$service")"
    if [ -n "$id" ]; then
      state="$(service_state "$id")"
      health="$(service_health "$id")"
      if [ "$health" = healthy ]; then return 0; fi
      if [ "$state" = exited ] || [ "$state" = dead ]; then
        show_service_logs "$service"
        fail "$service exited before becoming healthy."
      fi
    fi
    if [ "$(( $(date +%s) - started ))" -ge "$timeout" ]; then
      show_service_logs "$service"
      fail "Timed out waiting for $service health."
    fi
    sleep 2
  done
}

wait_for_migration() {
  local id exit_code
  id="$(service_id migrate)"
  [ -n "$id" ] || fail "Migration service did not create a container."
  [ "$(service_state "$id")" = exited ] || fail "Migration service did not finish."
  exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$id")"
  [ "$exit_code" = 0 ] || { show_service_logs migrate; fail "Database migration failed with exit code $exit_code."; }
}

retry() {
  local attempts="$1" delay="$2" label="$3"
  shift 3
  local attempt=1
  until "$@"; do
    if [ "$attempt" -ge "$attempts" ]; then
      printf '[FAIL] %s\n' "$label" >&2
      return 1
    fi
    attempt=$((attempt + 1))
    sleep "$delay"
  done
}
