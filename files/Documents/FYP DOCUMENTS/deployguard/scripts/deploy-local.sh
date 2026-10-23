#!/usr/bin/env bash
set -euo pipefail
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RESET='\033[0m'
info() { echo -e "${GREEN}[INFO]${RESET} $*"; }
warn() { echo -e "${YELLOW}[WARN]${RESET} $*"; }

cd "$(dirname "${BASH_SOURCE[0]}")/.."

[ ! -f backend/.env ]        && cp backend/.env.example backend/.env              && warn "Created backend/.env – update with real credentials"
[ ! -f frontend/.env.local ] && cp frontend/.env.example frontend/.env.local      && warn "Created frontend/.env.local"

info "Building and starting services..."
docker compose up --build -d

info "Waiting for services to be ready..."
for i in $(seq 1 12); do
  if curl -sf http://localhost:3001/api/v1/health >/dev/null 2>&1; then
    info "Backend is healthy!"; break
  fi
  echo "  waiting... ($i/12)"; sleep 5
done

echo ""
echo "  Frontend:   http://localhost:3000"
echo "  Backend:    http://localhost:3001"
echo "  API Docs:   http://localhost:3001/api/docs"
echo "  Prometheus: http://localhost:9090"
echo ""
echo "  Logs: docker compose logs -f"
