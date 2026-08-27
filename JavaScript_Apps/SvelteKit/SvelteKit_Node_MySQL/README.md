# SvelteKit adapter-node — MySQL

This is a minimal working DeployGuard test application.

## Environment
`.env` and `.env.example` are included. The values are local fixture values only.

## Database
Start MySQL locally, for example:
`docker run --rm --name dg-mysql -e MYSQL_DATABASE=appdb -e MYSQL_USER=app -e MYSQL_PASSWORD=app -e MYSQL_ROOT_PASSWORD=root -p 3306:3306 mysql:8.4`


## Install
```bash
npm install && npm run build
```

## Run
```bash
npm start
```

## Verify
Open:
- `http://localhost:3000/`
- `http://localhost:3000/health`

## DeployGuard purpose
Open this application directory as the repository under test. There is no Dockerfile; DeployGuard is expected to detect the framework/database/environment evidence and generate its own build/runtime plan.
