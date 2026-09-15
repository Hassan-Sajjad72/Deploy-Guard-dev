# DeployGuard Team Runtime Handoff

This package lets teammates run DeployGuard from published container images. It does not require cloning or modifying the frozen DeployGuard Test 2/Test 3 source code.

## Images

- Backend: `ghcr.io/hassan-sajjad72/deployguard-team-runtime-backend:test2-12ed477-runtime-1`
- Frontend: `ghcr.io/hassan-sajjad72/deployguard-team-runtime-frontend:test2-12ed477-runtime-1`

Both images are public and can be pulled from GHCR.

## Start

```bash
cp .env.example .env
# Fill in the required values in .env.
docker compose pull
docker compose up -d
./scripts/healthcheck.sh
```

Stop the runtime with:

```bash
docker compose down
```

## Shareable package

Use `deployguard-team-runtime-test2-12ed477-runtime-1.zip`. It excludes `.env` and Git metadata. Each teammate must create their own `.env` from `.env.example`.

## Freeze guarantee

The external runtime is pinned to frozen DeployGuard Test 2 source SHA `12ed47797fe82bee1bdec449936e57d7c27758e4`. No Test 2 or Test 3 application source code was changed for this runtime.
