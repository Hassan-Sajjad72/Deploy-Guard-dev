# Next.js standalone-configured — MongoDB

This is a minimal working DeployGuard test application.

## Environment
`.env` and `.env.example` are included. The values are local fixture values only.

## Database
Start MongoDB locally, for example:
`docker run --rm --name dg-mongo -p 27017:27017 mongo:8`


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
