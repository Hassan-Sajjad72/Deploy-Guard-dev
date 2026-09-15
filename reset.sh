#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/runtime-lib.sh"

verify_docker
require_runtime_env
printf '%s\n' 'This permanently deletes these named Docker volumes:'
printf '%s\n' '  - deployguard_team_runtime_postgres_data (PostgreSQL data)'
printf '%s\n' '  - deployguard_team_runtime_workspaces (DeployGuard runtime workspaces)'
printf '%s\n' '  - deployguard_team_runtime_prometheus_data (Prometheus history)'
printf '%s\n' '  - deployguard_team_runtime_grafana_data (Grafana data)'
read -r -p 'Type RESET_DEPLOYGUARD to continue: ' confirmation
[ "$confirmation" = RESET_DEPLOYGUARD ] || { printf 'Reset cancelled.\n'; exit 0; }
compose down -v --remove-orphans
printf 'DeployGuard team runtime data was removed.\n'
