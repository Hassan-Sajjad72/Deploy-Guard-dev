#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/runtime-lib.sh"

verify_docker
require_runtime_env
compose stop
printf 'DeployGuard team runtime stopped; named volumes were preserved.\n'
