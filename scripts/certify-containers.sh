#!/bin/sh
set -eu

env_file=${1:-.env.container}

if [ ! -f "$env_file" ]; then
  echo "Missing $env_file. Copy .env.container.example to .env.container first." >&2
  exit 1
fi

compose() {
  docker compose --env-file "$env_file" "$@"
}

echo "[1/9] Validating the Compose model"
compose config --quiet
services=$(compose config --services)
for required in postgres migrate backend frontend prometheus grafana; do
  printf '%s\n' "$services" | grep -qx "$required" || {
    echo "Required service is missing: $required" >&2
    exit 1
  }
done
if grep -E '(/home/|/Users/|[A-Za-z]:\\\\Users\\\\|host\.docker\.internal)' compose.yaml >/dev/null; then
  echo "Compose contains a developer-specific path or host-only service route." >&2
  exit 1
fi

echo "[2/9] Building and starting the complete product"
compose up --build --wait

echo "[3/9] Verifying migration and service health"
migrate_id=$(compose ps -a -q migrate)
[ -n "$migrate_id" ]
[ "$(docker inspect --format '{{.State.ExitCode}}' "$migrate_id")" = "0" ]
for service in postgres backend frontend prometheus grafana; do
  container_id=$(compose ps -q "$service")
  [ -n "$container_id" ]
  [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")" = "healthy" ]
done

echo "[4/9] Verifying backend runtime executables"
compose exec -T backend sh -ec '
  terraform version >/dev/null
  aws --version >/dev/null
  git --version >/dev/null
  ssh -V 2>&1 | grep -q OpenSSH
  curl --version >/dev/null
  infracost --version >/dev/null
'

echo "[5/9] Verifying frontend, API proxy, and SSE proxy configuration"
compose exec -T backend curl -fsS http://frontend:8080/healthz >/dev/null
compose exec -T backend curl -fsS http://frontend:8080/api/health/ready >/dev/null
compose exec -T frontend sh -ec '
  nginx -T 2>&1 | grep -q "proxy_pass http://backend:5000"
  nginx -T 2>&1 | grep -q "proxy_buffering off"
  nginx -T 2>&1 | grep -q "proxy_read_timeout 3600s"
'

echo "[6/9] Verifying Prometheus target health"
compose exec -T backend node -e '
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  (async () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await fetch("http://prometheus:9090/api/v1/targets");
      const body = await response.json();
      const target = body?.data?.activeTargets?.find(item => item?.labels?.job === "deployguard-aws-runtime");
      if (target?.health === "up" && target?.scrapeUrl?.includes("backend:5000/api/monitoring/metrics")) return;
      await wait(1000);
    }
    throw new Error("Prometheus did not report the DeployGuard backend target as up.");
  })().catch(error => { console.error(error.message); process.exit(1); });
'

echo "[7/9] Verifying Grafana health and provisioning"
compose exec -T backend node -e '
  (async () => {
    const health = await (await fetch("http://grafana:3000/api/health")).json();
    if (health.database !== "ok") throw new Error("Grafana database is not healthy.");
    const auth = Buffer.from(`${process.env.GRAFANA_ADMIN_USER}:${process.env.GRAFANA_ADMIN_PASSWORD}`).toString("base64");
    const dashboards = await (await fetch("http://grafana:3000/api/search?query=DeployGuard%20Runtime", { headers: { Authorization: `Basic ${auth}` } })).json();
    if (!dashboards.some(item => item.uid === "deployguard-runtime")) throw new Error("DeployGuard dashboard is not provisioned.");
  })().catch(error => { console.error(error.message); process.exit(1); });
'
compose exec -T grafana test -f /etc/grafana/provisioning/datasources/prometheus.yml
compose exec -T grafana test -f /etc/grafana/dashboards/deployguard-runtime.json

echo "[8/9] Verifying named-volume persistence across compose down"
compose exec -T postgres touch /var/lib/postgresql/data/.deployguard-container-certification
compose exec -T prometheus touch /prometheus/.deployguard-container-certification
compose exec -T grafana touch /var/lib/grafana/.deployguard-container-certification
compose exec -T backend touch /app/backend/.deployguard/.deployguard-container-certification
compose down
compose up --wait
compose exec -T postgres test -f /var/lib/postgresql/data/.deployguard-container-certification
compose exec -T prometheus test -f /prometheus/.deployguard-container-certification
compose exec -T grafana test -f /var/lib/grafana/.deployguard-container-certification
compose exec -T backend test -f /app/backend/.deployguard/.deployguard-container-certification

echo "[9/9] Container certification passed"
compose ps
