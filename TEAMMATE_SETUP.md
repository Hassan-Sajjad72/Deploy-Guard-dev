# DeployGuard teammate setup

## Requirements

- Docker Desktop with Docker Compose, or Docker Engine with the Compose plugin
- Internet access on the first run to download the pinned base/service images
- Free host ports 5173, 5000, 5433, 9090, and 3001

AWS CLI and Node.js are not required on the host for the Docker Compose startup path. DeployGuard cloud actions still require the transferred AWS and GitHub configuration to remain valid for the teammate and the configured callback URLs to use the same local ports.

## Start

From the unzipped directory, run:

```sh
docker compose up --build
```

The first start restores `transfer-data/deployguard-postgres.dump` into the new PostgreSQL volume. Later starts reuse that volume and do not restore the dump again.

Open DeployGuard at <http://localhost:5173>. Grafana is at <http://localhost:3001>, Prometheus at <http://localhost:9090>, and the backend API at <http://localhost:5000>.

To stop without deleting data:

```sh
docker compose down
```

Do not use `docker compose down --volumes` unless you intend to delete the imported PostgreSQL data and local monitoring history.
