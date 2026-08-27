# Angular + Express — MongoDB

This is one complete application folder with:
- `frontend/` — the named frontend framework
- `backend/` — a minimal API that owns the database connection
- `.env` / `.env.example` — local fixture configuration

There is no Dockerfile and no Docker Compose deployment file. DeployGuard must infer and generate deployment behavior.

## Database
Start MongoDB locally, for example:
`docker run --rm --name dg-mongo -p 27017:27017 mongo:8`


## Backend
```bash
cd backend
npm install
npm start
```
Backend listens on port `3001` and exposes `/health`.

## Frontend
In a second terminal:
```bash
cd frontend
npm install
npm run build
```

For frameworks with a development command, you can also run the framework dev server from `frontend/`.

## DeployGuard purpose
Test this whole application directory as a repository. It intentionally represents a frontend + backend topology with environment-variable ownership split between browser/build-time values and backend runtime/DB values.
