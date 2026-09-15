#!/usr/bin/env bash
set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/runtime-lib.sh"

verify_docker
require_runtime_env
failed=0
pass() { printf '[PASS] %s\n' "$1"; }
check() { if "$2"; then pass "$1"; else printf '[FAIL] %s\n' "$1" >&2; failed=1; fi; }

postgres_healthy() { [ "$(service_health "$(service_id postgres)")" = healthy ]; }
migration_success() { wait_for_migration >/dev/null; }
backend_ready() { compose exec -T backend node -e "fetch('http://127.0.0.1:5000/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; }
frontend_reachable() { compose exec -T frontend wget -qO- http://127.0.0.1:8080/healthz | grep -qx ok; }
prometheus_ready() { compose exec -T prometheus wget -qO- http://127.0.0.1:9090/-/ready >/dev/null; }
prometheus_scrapes_backend() { compose exec -T backend node -e "fetch('http://prometheus:9090/api/v1/targets').then(r=>r.json()).then(x=>process.exit(x.data.activeTargets.some(t=>t.labels.job==='deployguard-backend'&&t.health==='up')?0:1)).catch(()=>process.exit(1))"; }
grafana_healthy() { compose exec -T backend node -e "fetch('http://grafana:3000/api/health').then(r=>r.json()).then(x=>process.exit(x.database==='ok'?0:1)).catch(()=>process.exit(1))"; }
grafana_datasource() { compose exec -T backend node -e "const h='Basic '+Buffer.from(process.env.GRAFANA_ADMIN_USER+':'+process.env.GRAFANA_ADMIN_PASSWORD).toString('base64');fetch('http://grafana:3000/api/datasources/name/Prometheus',{headers:{authorization:h}}).then(r=>r.json()).then(x=>process.exit(x.url==='http://prometheus:9090'?0:1)).catch(()=>process.exit(1))"; }
grafana_dashboard() { compose exec -T backend node -e "const h='Basic '+Buffer.from(process.env.GRAFANA_ADMIN_USER+':'+process.env.GRAFANA_ADMIN_PASSWORD).toString('base64');fetch('http://grafana:3000/api/search?query=DeployGuard',{headers:{authorization:h}}).then(r=>r.json()).then(x=>process.exit(x.some(d=>d.uid==='deployguard-runtime')?0:1)).catch(()=>process.exit(1))"; }

check 'PostgreSQL healthy' postgres_healthy
check 'Database migrations successful' migration_success
check 'DeployGuard backend ready' backend_ready
check 'DeployGuard frontend reachable' frontend_reachable
check 'Prometheus ready' prometheus_ready
if retry 12 5 'Prometheus did not scrape DeployGuard.' prometheus_scrapes_backend; then pass 'Prometheus scraping DeployGuard'; else failed=1; fi
check 'Grafana healthy' grafana_healthy
check 'Grafana Prometheus datasource provisioned' grafana_datasource
check 'DeployGuard dashboard provisioned' grafana_dashboard

if [ "$failed" -ne 0 ]; then
  printf '\nDeployGuard team runtime: FAILED\n' >&2
  exit 1
fi
printf '\nDeployGuard team runtime: HEALTHY\n'
