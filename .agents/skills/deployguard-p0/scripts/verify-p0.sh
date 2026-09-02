#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
TAIL_LINES="${DEPLOYGUARD_P0_FAILURE_TAIL_LINES:-80}"

if ! [[ "$TAIL_LINES" =~ ^[1-9][0-9]*$ ]]; then
  printf 'INVALID_FAILURE_TAIL_LINES=%s\n' "$TAIL_LINES" >&2
  exit 2
fi

run_check() {
  local label="$1"
  shift
  local output status
  output="$(mktemp)"
  "$@" >"$output" 2>&1
  status=$?
  if [ "$status" -eq 0 ]; then
    rm -f "$output"
    printf '%s=PASS\n' "$label"
    return 0
  fi
  printf '%s=FAIL\nEXIT_STATUS=%s\n' "$label" "$status" >&2
  tail -n "$TAIL_LINES" "$output" >&2
  rm -f "$output"
  return "$status"
}

backend_script() {
  local label="$1" script="$2"
  run_check "$label" bash -c 'cd "$1/backend" && ./node_modules/.bin/ts-node "$2"' _ "$ROOT_DIR" "$script"
}

backend_test() {
  local label="$1" test_name="$2"
  run_check "$label" npm --prefix "$ROOT_DIR/backend" run "$test_name"
}

frontend_test() {
  local label="$1" test_name="$2"
  run_check "$label" npm --prefix "$ROOT_DIR/frontend" run "$test_name"
}

phase1() {
  backend_script GITHUB_BRANCH_CONTRACT scripts/verify-dispatch-state-projection.ts || return $?
  backend_script CONFIGURATION_ADMISSION scripts/verify-configuration-admission.ts || return $?
  backend_test ENV_SCOPE test:service-env-isolation || return $?
  printf 'P0_PHASE_1=PASS\n'
}

phase2() {
  backend_test PRETERRAFORM_RUNTIME test:application-runtime-validation || return $?
  backend_test MANAGED_DATABASE_CONTRACT test:railpack-runtime-contract || return $?
  backend_test DEPLOYMENT_READINESS_BOUNDARY test:railpack-materialization-workspace || return $?
  printf 'P0_PHASE_2=PASS\n'
}

phase3() {
  backend_test AWS_RUNTIME_CONTRACT test:multi-service-runtime || return $?
  backend_test FAILURE_OWNERSHIP test:failure-ownership || return $?
  backend_test DIAGNOSTICS_BOUNDARY test:troubleshooting-boundaries || return $?
  backend_script OBSERVABILITY_ENTRYPOINT scripts/verify-developer-observability-projection.ts || return $?
  frontend_test MONITORING_PRESENTATION test:monitoring-presentation || return $?
  printf 'P0_PHASE_3=PASS\n'
}

phase4() {
  backend_test PER_SERVICE_RELEASE test:multi-service-release || return $?
  backend_test LIFECYCLE_SEMANTICS test:lifecycle-properties || return $?
  backend_test TERMINAL_RECONCILIATION test:live-runtime-canonical-authority || return $?
  backend_test IMMUTABLE_RELEASE_IDENTITY test:immutable-runtime-revisions || return $?
  printf 'P0_PHASE_4=PASS\n'
}

case "${1:-}" in
  phase1|phase-1) phase1 ;;
  phase2|phase-2) phase2 ;;
  phase3|phase-3) phase3 ;;
  phase4|phase-4) phase4 ;;
  *)
    printf 'USAGE=%s {phase1|phase2|phase3|phase4}\n' "$0" >&2
    exit 2
    ;;
esac
