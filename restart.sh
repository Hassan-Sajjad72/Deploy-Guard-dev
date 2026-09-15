#!/usr/bin/env bash
set -Eeuo pipefail
RUNTIME_DIR="$(cd "$(dirname "$0")" && pwd)"
"$RUNTIME_DIR/stop.sh"
"$RUNTIME_DIR/start.sh"
