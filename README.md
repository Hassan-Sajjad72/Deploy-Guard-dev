# DeployGuard team runtime

This is a standalone Docker Compose runtime whose images are built by this
external repository from frozen DeployGuard Test 2 revision
`12ed47797fe82bee1bdec449936e57d7c27758e4`. It deliberately contains no source
build context or source-directory bind mount. Team laptops need only Git, Docker,
and Docker Compose. DeployGuard Test 2 and Test 3 are never modified.

```bash
cp .env.example .env
# replace every CHANGE_ME value in .env
./start.sh
```

The pinned GHCR images must be published by the source repository workflow
before first use. If the package is private, authenticate once with
`docker login ghcr.io`; this is an image-registry permission, not a project
dependency.

URLs after a successful start:

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:5000`
- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3001`

`stop.sh` and `restart.sh` preserve all named data volumes. `reset.sh` requires
the exact confirmation text before deleting PostgreSQL, DeployGuard workspace,
Prometheus, and Grafana data.
