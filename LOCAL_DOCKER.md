# DeployGuard local Docker distribution

This distribution runs the complete local DeployGuard control plane without a host Node.js or PostgreSQL installation. It starts five services: the React/nginx frontend, NestJS backend, PostgreSQL metadata store, Prometheus, and Grafana. Redis, BullMQ workers, and Trivy are not retained startup services and are not included.

## Start from published images

Prerequisite: Docker Engine/Desktop with Docker Compose. Copy the safe template and replace every `CHANGE_ME` value that applies to your authorized environment:

```bash
cp .env.example .env
docker compose pull
docker compose up -d --wait
```

Set `DEPLOYGUARD_IMAGE_NAMESPACE` to the Docker Hub user or organization that publishes DeployGuard and set `DEPLOYGUARD_IMAGE_TAG` to an immutable release version. PostgreSQL, Prometheus, and Grafana use their pinned official upstream images.

For source development, build the two DeployGuard images locally:

```bash
cp .env.example .env
# Replace CHANGE_ME values, and use DEPLOYGUARD_IMAGE_TAG=local if desired.
docker compose up -d --build --wait
```

Migrations run automatically in the one-shot `migrate` service after PostgreSQL is healthy. The backend starts only after migrations succeed; the frontend and monitoring services start through health-gated dependencies.

## Local URLs

- Frontend: <http://localhost:5173>
- Backend/API readiness: <http://localhost:5000/api/health/ready>
- Prometheus: <http://localhost:9090>
- Grafana dashboard: <http://localhost:3001/d/deployguard-runtime/deployguard-runtime>

The frontend image uses same-origin API requests. nginx proxies `/api/*` and `/auth/*` to the internal `backend:5000` service, including long-lived SSE responses. Browser-visible links and OAuth callbacks use `localhost`, never Docker-only service names.

## GitHub configuration

Create/configure the teammate's GitHub OAuth App with:

- Homepage URL: `http://localhost:5173`
- Authorization callback URL: `http://localhost:5173/api/auth/github/callback`

The GitHub App ID, slug, and one-line private key must match an installed, authorized GitHub App. The reusable-workflow reference must remain an immutable 40-character commit SHA. Deployment continues through GitHub Actions and OIDC; this package does not introduce PAT deployment.

## AWS safety

Use the existing dedicated least-privilege DeployGuard development roles and shared-foundation values. Never use root credentials or add `AdministratorAccess`. The local backend accepts short-lived AWS environment credentials only for the current read/management functions that run locally; customer deployment workflows continue assuming `DEPLOYGUARD_GITHUB_ACTIONS_ROLE_ARN` through GitHub OIDC.

Starting this Compose stack does not create or destroy AWS resources. Pressing lifecycle controls in the product can trigger real GitHub Actions/AWS work when credentials and foundation values are configured.

## Persistence and shutdown

Named volumes:

- `postgres_data`: DeployGuard control-plane metadata and history
- `prometheus_data`: local metric history
- `grafana_data`: Grafana state
- `deployguard_workspaces`: bounded generated control-plane workspace files

Stop containers while retaining data:

```bash
docker compose down
```

Delete all local Compose data (destructive only to this local control plane; it does not invoke project Destroy or mutate AWS):

```bash
docker compose down -v
```

## Publish multi-platform images

```bash
export IMAGE_NAMESPACE=your-dockerhub-user
export IMAGE_TAG=1.0.0

docker buildx build --platform linux/amd64,linux/arm64 \
  -f backend/Dockerfile \
  -t "$IMAGE_NAMESPACE/deployguard-backend:$IMAGE_TAG" \
  --push .

docker buildx build --platform linux/amd64,linux/arm64 \
  -f frontend/Dockerfile \
  -t "$IMAGE_NAMESPACE/deployguard-frontend:$IMAGE_TAG" \
  --push .
```

Do not publish `latest` as the only supported reference. Teammates should pin a version with `DEPLOYGUARD_IMAGE_TAG`.

## Diagnostics

```bash
docker compose ps
docker compose logs migrate backend frontend prometheus grafana
docker compose exec postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

PostgreSQL is intentionally not exposed to the host. Use `docker compose exec postgres psql ...` for authorized local diagnostics.
