#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/runtime-lib.sh"

verify_docker
require_runtime_env
printf '%-12s %-10s %-10s %-68s %s\n' SERVICE STATE HEALTH IMAGE PORTS
for service in postgres migrate backend frontend prometheus grafana; do
  id="$(service_id "$service")"
  if [ -z "$id" ]; then
    printf '%-12s %-10s %-10s %-68s %s\n' "$service" absent n/a n/a n/a
    continue
  fi
  docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}|{{.Config.Image}}|{{range $p, $v := .NetworkSettings.Ports}}{{$p}}={{range $v}}{{.HostPort}} {{end}}{{end}}' "$id" \
    | awk -F'|' -v service="$service" '{printf "%-12s %-10s %-10s %-68s %s\n", service, $1, $2, $3, $4}'
done
