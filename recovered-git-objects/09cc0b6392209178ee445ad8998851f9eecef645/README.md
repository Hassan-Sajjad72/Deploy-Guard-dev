# GitHub OAuth Authentication App

A full-stack app with GitHub OAuth using Vite + React (frontend), NestJS (backend), and PostgreSQL (database).

## Project Structure

```
github-auth-app/
├── frontend/          ← Vite + React app (runs on port 5173)
├── backend/           ← NestJS app (runs on port 5000)
├── database/          ← SQL setup script for pgAdmin 4
└── README.md
```

---

## STEP 1 — Create GitHub OAuth App

1. Go to: https://github.com/settings/developers
2. Click **"New OAuth App"**
3. Fill in:
   - **Application name**: `My Auth App` (any name)
   - **Homepage URL**: `http://localhost:5173`
   - **Authorization callback URL**: `http://localhost:5000/api/auth/github/callback`
4. Click **Register application**
5. Copy the **Client ID** and generate a **Client Secret**
6. Save both — you'll need them in the next steps

---

## STEP 2 — Setup PostgreSQL with pgAdmin 4

1. Open **pgAdmin 4**
2. Right-click **Databases** → **Create** → **Database**
3. Name it: `github_auth_db` → click **Save**
4. Click on `github_auth_db` in the left panel
5. Click **Tools → Query Tool**
6. Paste the contents of `database/setup.sql` and click **Run (▶)**
7. You should see the `users` table created

---

## STEP 3 — Setup Backend (NestJS)

```bash
cd backend

# Copy and fill in environment variables
cp .env.example .env
```

Edit `.env` and fill in:
```
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=YOUR_ACTUAL_POSTGRES_PASSWORD
DB_NAME=github_auth_db
FRONTEND_URL=http://localhost:5173
PORT=5000
```

Then install and run:
```bash
npm install
npm run start:dev
```

You should see: `NestJS Backend running! URL: http://localhost:5000`

---

## STEP 4 — Setup Frontend (Vite + React)

```bash
cd frontend

# Copy and fill in environment variables
cp .env.local.example .env.local
```

Edit `.env.local` and fill in:
```
GITHUB_CLIENT_ID=paste_your_github_client_id_here
GITHUB_CLIENT_SECRET=paste_your_github_client_secret_here
NEXTAUTH_SECRET=run_this_command_and_paste_output: openssl rand -base64 32
VITE_API_BASE_URL=http://localhost:5000
```

Then install and run:
```bash
npm install
npm run dev
```

You should see: `VITE ready on http://localhost:5173`

---

## STEP 5 — Test It

1. Open http://localhost:5173
2. You'll be redirected to `/auth/login`
3. Click **"Sign in with GitHub"**
4. Approve the GitHub OAuth permission screen
5. You'll land on `/home` showing your profile
6. In pgAdmin 4, run: `SELECT * FROM users;` — you should see your row!

---

## How the pieces connect

```
Browser (port 5173)
    ↕  Vite + React frontend
    ↕  HTTP POST to /auth/github/callback
NestJS Backend (port 5000)
    ↕  TypeORM SQL queries
PostgreSQL (port 5432)
    ↕  pgAdmin 4 to view/manage data
```

## Safe local normal-v1 demo

The repository-owned demo runs a disposable normal-v1 release through the real
authenticated HTTP, PostgreSQL, Redis/BullMQ, worker and Overview boundaries.
Only the external release executor is replaced by the deterministic non-cloud
fixture. Production, Docker, Terraform, ECR, ECS and AWS execution are not
reachable; the command refuses to start with `NODE_ENV=production`.

```bash
npm run demo:normal-v1-local -- start
npm run demo:normal-v1-local -- status
npm run demo:normal-v1-local -- stop
```

`start` waits for PostgreSQL, Redis, the backend, frontend and scoped worker,
then prints the disposable operation/job evidence and rendered phase result.
`stop` sends graceful SIGTERM, removes the disposable database and Redis data,
stops only Compose dependencies started by the demo, removes its temporary
state/log files and leaves all activation gates default-off.

For the final self-checking walkthrough and persisted evidence bundle, run
`npm run demo:fyp-local`. It performs start, two refresh-safe status
observations and stop in one command, then writes JSON, Markdown and SHA-256
evidence documented in [FYP_LOCAL_DEMO.md](./docs/FYP_LOCAL_DEMO.md).

The canonical Overview operation binds Analyze to the exact deployment-contract
preflight fingerprint and Build to policy evidence for the exact immutable
image. The local fixture emits one deterministic allowed image check. Missing
or failed scanner evidence renders `unavailable`, and a blocked policy renders
`blocked`; neither can be presented as a Live operation. Only safe codes,
states and observation timestamps are returned to the browser.

The same current-state response supplies a bounded operation-observability
view: rollout health, five phase events, phase/effect counts, duration and up
to six recognized side-effect activity entries. These signals are derived
from the exact intent and its fenced journals. Worker IDs, operation leases,
fences, journal identities, request fingerprints and external references are
never returned. `demo:normal-v1-local -- status` summarizes the proven signal
counts without opening an additional frontend polling path. The same demo also
verifies authenticated refresh consistency on Overview and Pipeline, then on
Dashboard and Plan & Usage through their existing single workspace-summary
boundary. Pipeline does not fetch or present legacy run history when a
canonical normal-v1 operation exists, and a live URL is shown only from the
stable-release projection.

The bounded failure/reconciliation proof is also repository-owned and remains
test-only:

```bash
cd backend
npm run test:normal-v1-local-failure-recovery:integration
```

It makes the fixture's first Verify observation ambiguous, projects the same
operation as `reconciling`, and lets the default-off bounded convergence
scheduler retry the same frozen BullMQ job. The second observation completes
without another outbox publication or side-effect journal. Production release
composition and AWS readers are unchanged; the fixture gate is rejected unless
the process is explicitly running in test mode with one exact project/`dev`
scope.

Normal-v1 deletion is deliberately outside this developer demo. The frozen
protocol still reserves `intent.deletion.execute`, but repository consumer
startup rejects the deletion role before registering a capability or opening a
BullMQ worker, and the placeholder cannot report successful deletion. Project
resource cleanup remains an administrator-only operational surface until a
dedicated fenced normal-v1 deletion handler and supervisor are implemented.

## Default-off infrastructure consumer supervision

The existing infrastructure plan and separately approved apply workers use the
same repository-owned Docker Compose convention as the release consumer. They
remain absent from ordinary `docker compose up` and must be selected
individually:

```bash
docker compose --env-file backend/.env \
  --profile normal-v1-infrastructure-plan up -d \
  normal-v1-infrastructure-plan-consumer

docker compose --env-file backend/.env \
  --profile normal-v1-infrastructure-apply up -d \
  normal-v1-infrastructure-apply-consumer
```

Every consumer, execution, ownership and exact one-project/`dev` gate in
`backend/.env.example` defaults off. Disabled or invalid configuration records
sanitized health and exits successfully without a restart loop. Exact scope
uses concurrency one, bounded `on-failure:3` restart, a 90-second SIGTERM drain,
Terraform 1.10.5 and a shared saved-plan workspace. The infrastructure services
do not mount the Docker socket.

Read-only status collection uses the role-specific compiled command:

```bash
docker compose --profile normal-v1-infrastructure-plan exec \
  normal-v1-infrastructure-plan-consumer \
  node dist/src/normal-v1-infrastructure-plan-consumer.health.js status

docker compose --profile normal-v1-infrastructure-apply exec \
  normal-v1-infrastructure-apply-consumer \
  node dist/src/normal-v1-infrastructure-apply-consumer.health.js status
```

The six-field record contains only state, readiness/liveness, a sanitized safe
code and observation time. It never contains project/intent IDs, queue payloads,
fences, journals, cloud identifiers or credentials. The focused local lifecycle
proof is `cd backend && npm run test:normal-v1-infrastructure-consumer-supervision`.

## Default-off automatic normal-v1 deployment command

The developer Overview and Deployments pages call one authenticated command:
`POST /api/projects/:projectId/deploy`. The API prepares or reuses the existing
immutable normal-v1 intent and publishes only its exact outbox. A default-off,
restart-safe API scheduler observes only command-marked first-release intents;
it reviews the saved Terraform plan with real Infracost evidence, applies the
configured cost policy, dispatches the exact apply continuation when authorized,
and prepares/dispatches the release after infrastructure is durably applied.
It never starts or supervises a worker.

`TWO_LANE_NORMAL_AUTOMATIC_DEPLOY_ENABLED=false` is the controlling gate.
The default monthly threshold is configured by
`NORMAL_V1_DEFAULT_COST_THRESHOLD_MONTHLY` (project cost settings override it),
and `NORMAL_V1_AUTOMATIC_MAX_RESOURCE_CHANGES` bounds automatic approval.
Non-real cost evidence fails closed. Replacement/deletion or an unusually broad
plan pauses for an operator; above-threshold safe plans expose only the owner-only
`POST /api/projects/:projectId/deploy/approve-cost` action. Direct prepare and
exact-dispatch routes are administrator-only compatibility/operator boundaries.
