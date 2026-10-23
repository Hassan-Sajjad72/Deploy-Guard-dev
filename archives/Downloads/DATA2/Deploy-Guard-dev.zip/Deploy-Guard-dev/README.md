# GitHub OAuth Authentication App

A full-stack app with GitHub OAuth using Next.js (frontend), NestJS (backend), and PostgreSQL (database).

## Project Structure

```
github-auth-app/
├── frontend/          ← Next.js app (runs on port 3000)
├── backend/           ← NestJS app (runs on port 4000)
├── database/          ← SQL setup script for pgAdmin 4
└── README.md
```

---

## STEP 1 — Create GitHub OAuth App

1. Go to: https://github.com/settings/developers
2. Click **"New OAuth App"**
3. Fill in:
   - **Application name**: `My Auth App` (any name)
   - **Homepage URL**: `http://localhost:3000`
   - **Authorization callback URL**: `http://localhost:3000/api/auth/callback/github`
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
FRONTEND_URL=http://localhost:3000
PORT=4000
```

Then install and run:
```bash
npm install
npm run start:dev
```

You should see: `NestJS Backend running! URL: http://localhost:4000`

---

## STEP 4 — Setup Frontend (Next.js)

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
NEXTAUTH_URL=http://localhost:3000
NEXT_PUBLIC_BACKEND_URL=http://localhost:4000
```

Then install and run:
```bash
npm install
npm run dev
```

You should see: `Next.js ready on http://localhost:3000`

---

## STEP 5 — Test It

1. Open http://localhost:3000
2. You'll be redirected to `/auth/login`
3. Click **"Sign in with GitHub"**
4. Approve the GitHub OAuth permission screen
5. You'll land on `/home` showing your profile
6. In pgAdmin 4, run: `SELECT * FROM users;` — you should see your row!

---

## How the pieces connect

```
Browser (port 3000)
    ↕  NextAuth handles GitHub OAuth
Next.js Frontend
    ↕  HTTP POST to /auth/github/callback
NestJS Backend (port 4000)
    ↕  TypeORM SQL queries
PostgreSQL (port 5432)
    ↕  pgAdmin 4 to view/manage data
```
