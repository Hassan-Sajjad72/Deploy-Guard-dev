# Nested FastAPI — PostgreSQL

This is a minimal working DeployGuard test application.

## Environment
`.env` and `.env.example` are included. The values are local fixture values only.

## Database
Start PostgreSQL locally, for example:
`docker run --rm --name dg-postgres -e POSTGRES_DB=appdb -e POSTGRES_USER=app -e POSTGRES_PASSWORD=app -p 5432:5432 postgres:17-alpine`


## Install
```bash
pip install -r requirements.txt
```

## Run
```bash
uvicorn backend.api.application:app --host 0.0.0.0 --port 3000
```

## Verify
Open:
- `http://localhost:3000/`
- `http://localhost:3000/health`

## DeployGuard purpose
Open this application directory as the repository under test. There is no Dockerfile; DeployGuard is expected to detect the framework/database/environment evidence and generate its own build/runtime plan.
