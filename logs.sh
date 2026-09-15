#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/runtime-lib.sh"

verify_docker
require_runtime_env
if [ "$#" -gt 1 ]; then fail 'Usage: ./logs.sh [backend|frontend|postgres|prometheus|grafana|migrate]'; fi
if [ "$#" -eq 1 ]; then
  case "$1" in backend|frontend|postgres|prometheus|grafana|migrate) ;; *) fail "Unknown service: $1" ;; esac
fi
compose logs --tail=200 -f "$@"
