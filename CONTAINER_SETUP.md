```sh
git clone https://github.com/Hassan-Sajjad72/Deploy-Guard-dev.git
cd Deploy-Guard-dev
cp .env.container.example .env.container
docker compose --env-file .env.container up --build --wait
```

# DeployGuard container setup

The command above starts the complete local product. It requires Git, Docker
Engine/Desktop, and Docker Compose 2.20 or newer. No host Node.js, npm,
PostgreSQL, Terraform, AWS CLI, or Infracost installation is used.
`npm run product:start` remains a compatibility wrapper for developers who
already have npm, but Docker Compose is the canonical startup path.

On Windows, run the commands in WSL2. In PowerShell, replace the copy command
with `Copy-Item .env.container.example .env.container`.

Before live GitHub, AWS, Stripe, notification, or AI use, edit
`.env.container` and supply that integration's credentials. Empty optional
credentials retain the application's existing unconfigured/disabled behavior.
Never commit this file.

## URLs

- DeployGuard: http://localhost:5173
- Backend health: http://localhost:5000/api/health/ready
- Prometheus: http://localhost:9090
- Grafana: http://localhost:3001/d/deployguard-runtime/deployguard-runtime

All browser URLs use localhost. Inside the Compose network, services use
`postgres`, `backend`, `prometheus`, and `grafana` DNS names.

## Daily commands

```sh
# Status and logs
docker compose --env-file .env.container ps
docker compose --env-file .env.container logs -f

# Stop containers while retaining PostgreSQL, Prometheus, Grafana, and workspace data
docker compose --env-file .env.container down

# Rebuild after source changes
docker compose --env-file .env.container up --build --wait

# Destructive local reset (deletes all four named data volumes)
docker compose --env-file .env.container down -v
```

## Existing PostgreSQL data

For a one-time import into a new local database, place a PostgreSQL custom dump
at `transfer-data/deployguard-postgres.dump` before the first startup. The
database image restores it only while PostgreSQL is initializing an empty named
volume. Normal clean startup does not require a dump, and an initialized
database is never overwritten automatically.

To intentionally replace local data, stop the stack, run the documented
`down -v` reset, place the supported dump, and start again. Back up anything
important first.

## Certification

The certification uses Docker and Compose only:

```sh
sh scripts/certify-containers.sh
```

It validates the Compose model, builds and starts the stack, checks migrations,
health endpoints, nginx API/SSE proxying, the Prometheus target, Grafana
provisioning, backend runtime tools, and named-volume persistence across
`docker compose down`.

To compile every custom image for both supported CPU architectures:

```sh
docker buildx build --platform linux/amd64,linux/arm64 --file backend/Dockerfile --output type=cacheonly .
docker buildx build --platform linux/amd64,linux/arm64 --file frontend/Dockerfile --output type=cacheonly .
docker buildx build --platform linux/amd64,linux/arm64 --file database/Dockerfile --output type=cacheonly .
docker buildx build --platform linux/amd64,linux/arm64 --file monitoring/prometheus.Dockerfile --output type=cacheonly .
docker buildx build --platform linux/amd64,linux/arm64 --file monitoring/grafana.Dockerfile --output type=cacheonly .
```

## Troubleshooting

- A missing-variable message means Compose was not given `--env-file
  .env.container`, or the file is incomplete.
- A port conflict can be resolved by changing the corresponding published port
  in `.env.container`.
- Inspect a failed migration with `docker compose --env-file .env.container
  logs migrate postgres`.
- Inspect readiness with `docker compose --env-file .env.container logs
  backend prometheus grafana`.
- Docker Desktop must use Linux containers. WSL2 integration is recommended on
  Windows; Docker Desktop runs the same multi-architecture images natively on
  Intel and Apple Silicon macOS.
