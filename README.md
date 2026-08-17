# DeployGuard

## Running DeployGuard with Docker

Requirements: Git, Docker or Docker Desktop with Docker Compose, repository access, and an authorized runtime environment file.

```bash
git clone https://github.com/Hassan-Sajjad72/Deploy-Guard-dev.git
cd Deploy-Guard-dev
git switch container-setup
cp .env.example .env
# Replace every required CHANGE_ME value with credentials supplied privately.
docker compose up -d --build --wait
```

Open:

- DeployGuard UI: <http://localhost:5173>
- DeployGuard API readiness: <http://localhost:5000/api/health/ready>
- Prometheus: <http://localhost:9090>
- Grafana: <http://localhost:3001>

GitHub OAuth must use `http://localhost:5173` as the homepage and
`http://localhost:5173/api/auth/github/callback` as the authorization callback.
Do not use Docker service names in browser-facing callback URLs.

Useful commands:

```bash
docker compose ps
docker compose logs -f backend
docker compose logs -f
docker compose down

# Pull repository changes and rebuild local images.
git pull
docker compose up -d --build --wait
```

Named volumes retain PostgreSQL, Prometheus, Grafana, and DeployGuard workspace
data across `docker compose down`. The following is a destructive local-only
reset; it does not invoke DeployGuard Destroy and does not modify AWS:

```bash
docker compose down -v
```

See [LOCAL_DOCKER.md](LOCAL_DOCKER.md) for environment categories, AWS safety,
diagnostics, persistence details, and the complete local distribution notes.
