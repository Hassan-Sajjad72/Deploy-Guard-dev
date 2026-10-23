# Production Blueprint: 100% Deterministic Tech Stack & 3-Tier Architecture Detector
*(Targeted Exclusively at Python, JavaScript/TypeScript Ecosystems & Multi-Tier Repository Structures)*

---

## Executive Summary & Design Philosophy

Most tech stack detection tools (e.g., GitHub Linguist, Wappalyzer, simple regex scanners) fail to achieve 100% accuracy because they rely on **shallow heuristics**: matching filenames or checking top-level dependency lists. This leads to rampant false positives and false negatives:
* **The "Unused Dependency" Trap:** A dependency (e.g., `flask` or `express`) remains in `package.json` or `requirements.txt`, but was abandoned or is only used in tests.
* **The "Meta-Framework Masking" Trap:** An app has `react` installed, so it gets classified as a raw SPA, completely missing that it is actually a server-rendered `Next.js` App Router application.
* **The "Monorepo Blending" Trap:** Root dependencies for developer tooling (linters, test servers) bleed into production application detection, obscuring multi-tier boundaries.
* **The "Ghost Infrastructure" Trap:** A repository has a `Dockerfile` for an ancient experiment, while the live app runs via Serverless functions or Docker Compose.

To achieve **100 out of 100 accuracy**, this detector uses a **Deterministic 5-Pillar Verification Model** with strict evidence chaining, static Abstract Syntax Tree (AST) validation, and multi-tier network/orchestration topology stitching.

```
┌────────────────────────────────────────────────────────────────────────┐
│               DETERMINISTIC STACK DETECTION ENGINE PIPELINE            │
└────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 0: Workspace Boundary & Repo Topology Resolver                  │
│ • Detect Monorepo Root (Turborepo, Nx, Lerna, PNPM/Yarn Workspaces)    │
│ • Isolate Components (apps/*, services/*, frontend/, backend/, api/)   │
└────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 1: Package Manifest & Lockfile Extractor                         │
│ • Parse package.json, pnpm-lock, yarn.lock, bun.lock                   │
│ • Parse pyproject.toml, requirements*.txt, Pipfile, poetry.lock, uv    │
│ • Classify Direct vs. Dev vs. Transitive dependencies                  │
└────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 2: Configuration & Anchor File Verification                      │
│ • Framework anchors: next.config.js, vite.config.ts, nuxt.config.ts    │
│ • Python anchors: manage.py, settings.py, alembic.ini, asgi.py/wsgi.py │
│ • ORM/Schema anchors: prisma/schema.prisma, drizzle.config.ts          │
└────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 3: Static AST Import & Entrypoint Verification Engine            │
│ • Python AST: from fastapi import FastAPI -> app = FastAPI()           │
│ • JS/TS AST: import express from 'express' -> const app = express()    │
│ • Elimination of dead/test-only dependencies                           │
└────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 4: Infrastructure & Orchestration Grapher                        │
│ • Parse docker-compose.yml, Dockerfile, Procfile, Helm charts          │
│ • Extract Port bindings, Service dependencies, and Env vars            │
│ • Identify Databases (Postgres, Mongo, Redis, MySQL, SQLite)           │
└────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 5: 3-Tier Stitcher & Disambiguation Consensus Engine             │
│ • Presentation Tier <─── Proxy/API Calls ───> Application Tier         │
│ • Application Tier  <─── ORM/Drivers ───────> Database Tier           │
│ • Meta-framework elevation (Next.js overrides raw React SPA)           │
│ • Strict Schema Validation & Output Delivery                           │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Domain Model & Supported Ecosystem Taxonomy

The engine is strictly constrained to **Python** and **JavaScript / TypeScript** to prevent scope bloat and guarantee exhaustive precision.

### 1.1 Python Web Frameworks
| Category | Frameworks | Critical Signatures |
| :--- | :--- | :--- |
| **Enterprise Fullstack** | **Django**, Django REST Framework (DRF), Django Ninja | `manage.py`, `settings.py`, `DJANGO_SETTINGS_MODULE`, `django.core.wsgi`, `urls.py` |
| **Modern Async API** | **FastAPI**, **Litestar** (formerly Starlite), **Starlette** | `from fastapi import FastAPI`, `app = FastAPI()`, `uvicorn.run`, Pydantic models |
| **Micro-Frameworks** | **Flask**, **Quart**, **Bottle** | `from flask import Flask`, `Flask(__name__)`, `app.route`, Blueprints |
| **High-Performance Async** | **Sanic**, **Tornado**, **AIOHTTP** | `sanic.Sanic`, `tornado.web.Application`, `aiohttp.web.Application` |
| **Specialized / Data** | **Streamlit**, **Dash** | `import streamlit as st`, `dash.Dash()` |

### 1.2 JavaScript / TypeScript Frameworks
| Category | Frameworks | Critical Signatures |
| :--- | :--- | :--- |
| **Fullstack Meta-Frameworks** | **Next.js** (App Router / Pages Router), **Nuxt** (v2/v3), **Remix / React Router v7**, **SvelteKit**, **Astro**, **SolidStart** | `next.config.js`, `app/layout.tsx`, `pages/_app.tsx`, `nuxt.config.ts`, `remix.config.js`, `astro.config.mjs` |
| **SPA UI Frameworks** | **React**, **Vue** (v2/v3), **Svelte**, **Angular**, **Solid.js** | `vite.config.ts`, `angular.json`, `createApp()`, `ReactDOM.createRoot()`, `src/App.vue` |
| **Backend / API Frameworks** | **Express.js**, **NestJS**, **Fastify**, **Koa**, **Hono**, **AdonisJS**, **Sails.js**, **Nitro** | `nest-cli.json`, `@Module()`, `express()`, `fastify()`, `new Hono()`, `adonisrc.json` |
| **API Layer / RPC** | **tRPC**, **GraphQL** (Apollo, Yoga), **Socket.io** | `@trpc/server`, `initTRPC.create()`, `ApolloServer`, `io.on('connection')` |

### 1.3 Data & Persistence Layer (Tiers 3)
| Category | Libraries / ORMs / Drivers | Databases Detected |
| :--- | :--- | :--- |
| **Python Data Layer** | SQLAlchemy, Django ORM, Tortoise-ORM, Peewee, SQLModel, Motor, Beanie, PyMongo, asyncpg, psycopg2 | PostgreSQL, MySQL, SQLite, MongoDB, Redis, CockroachDB |
| **JS/TS Data Layer** | Prisma, Drizzle ORM, TypeORM, Mongoose, Sequelize, Knex.js, MikroORM, Kysely, Supabase Client | PostgreSQL, MySQL, SQLite/LibSQL, MongoDB, Redis, Cassandra |

### 1.4 Repository Structure Archetypes
1. **Single-tier Monolith:** Fullstack Django with templates or Fullstack Next.js with Server Actions.
2. **Coupled 2-Tier / 3-Tier Flat Repo:** Subfolders `frontend/` and `backend/`, or `client/` and `server/`.
3. **Formal Monorepo:** Monorepo orchestrator (`pnpm-workspace.yaml`, `turborepo.json`, `nx.json`, `lerna.json`, `rush.json`) with `apps/*` and `packages/*`.
4. **Service-Oriented / Microservice Monorepo:** Multiple backend APIs (e.g. FastAPI Auth Service + Express Notification Service + Next.js Web App).

---

## 2. Multi-Pass Detection Pipeline (The 5 Pillars)

To attain zero false positives and zero false negatives, detection is executed in sequential, mutually reinforcing passes.

```
+---------------------------------------------------------------------------------+
|                               DETECTION PIPELINE                                 |
+---------------------------------------------------------------------------------+
   Pass 0: Filesystem Scan & Worktree Indexing (Exclude ignored paths)
        |
   Pass 1: Repository Structure & Component Boundary Segmentation
        |
   Pass 2: Manifest & Dependency Parsing (Direct vs Transitive vs Dev)
        |
   Pass 3: Configuration & Anchor File Correlation
        |
   Pass 4: Static AST Code Import & Entrypoint Verification
        |
   Pass 5: Infrastructure & Orchestration Analysis (Docker/Compose/Env)
        |
   Pass 6: Tier Classification & Inter-Service Dependency Stitching
        |
   Pass 7: Conflict Resolution & Final JSON Output Generation
+---------------------------------------------------------------------------------+
```

---

### Pass 0: Filesystem Indexing & Smart Filtering
Before any analysis, build an in-memory normalized file tree.
* **Strict Blacklist (Skip traversing):**
  * `node_modules/`, `venv/`, `.venv/`, `env/`, `__pycache__/`, `.git/`, `.turbo/`, `.next/`, `.nuxt/`, `dist/`, `build/`, `out/`, `coverage/`, `.cache/`, `.pytest_cache/`.
* **Max File Read Limits:**
  * Do not read entire large files into memory. AST scans are targeted only at potential entry points, routes, and config files (files under 1 MB).

---

### Pass 1: Repository Structure & Component Boundary Segmentation

A project is rarely just a single directory. We must segment the repository into discrete **Components**.

```
Repository Root
 ├── pnpm-workspace.yaml  <── Identified as Monorepo Root (PNPM)
 ├── apps/
 │    ├── web/           <── Component 1: Frontend SPA / Meta-framework
 │    │    ├── package.json
 │    │    └── next.config.mjs
 │    └── docs/          <── Component 2: Documentation
 ├── services/
 │    └── api/           <── Component 3: Backend REST API
 │         ├── pyproject.toml
 │         └── main.py
 └── docker-compose.yml  <── Orchestrator Linking Component 1 & 3 to Postgres
```

#### Monorepo Boundary Detection Heuristics:
1. **PNPM Workspaces:** File `pnpm-workspace.yaml` containing `packages:` globs.
2. **Turborepo:** `turbo.json` at root + `workspaces` in root `package.json`.
3. **Nx:** `nx.json` at root or `project.json` in subdirectories.
4. **Lerna:** `lerna.json`.
5. **NPM / Yarn Workspaces:** Root `package.json` contains `"workspaces": [...]`.
6. **Heuristic Polyrepo / Multi-folder:** No monorepo config, but presence of:
   * `frontend/` + `backend/`
   * `client/` + `server/`
   * `web/` + `api/`
   * `ui/` + `core/`

Each resolved component receives a unique `component_id`, its relative path, and its detected role candidate (`frontend`, `backend`, `fullstack`, `library`, `infra`).

---

### Pass 2: Manifest & Dependency Parsing (Strict Isolation)

Dependencies are extracted per component boundary. A dependency in the monorepo root is **never** attributed to a sub-component unless explicitly inherited.

#### Python Manifest Resolvers:
1. **`pyproject.toml` (PEP 518/621):**
   * Check `[project.dependencies]`
   * Check `[tool.poetry.dependencies]`
   * Check `[tool.flit.metadata]`
   * Check `[tool.pdm.dev-dependencies]` vs production dependencies.
2. **`requirements*.txt`:**
   * Distinguish between `requirements.txt`, `requirements-dev.txt`, `test-requirements.txt`.
   * Strip version specifiers (`fastapi>=0.100.0` -> `fastapi`).
   * Ignore comments (`# ...`) and environment markers.
3. **Lockfiles:**
   * `poetry.lock`, `Pipfile.lock`, `pdm.lock`, `uv.lock`.
   * Extract locked exact version numbers.

#### JavaScript / TypeScript Manifest Resolvers:
1. **`package.json`:**
   * Separate `dependencies` (Production runtime) from `devDependencies` (Build/test tools) and `peerDependencies`.
   * **Critical Rule:** If a framework like `express` appears only in `devDependencies`, it is flagged as `DEVELOPMENT_ONLY` unless confirmed by Pass 4 (AST scan).
2. **Lockfiles:**
   * `package-lock.json` (v2 and v3 format), `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`.
   * Parse to verify true pinned versions.

---

### Pass 3: Configuration & Anchor File Verification

A framework almost never exists in a vacuum; it requires a designated configuration file or canonical file structure.

#### Framework Anchor Registry:
* **Next.js:**
  * Anchor: `next.config.js`, `next.config.mjs`, `next.config.ts`.
  * Structure: `app/layout.tsx` (App Router) OR `pages/_app.tsx` (Pages Router).
* **Vite / React / Vue / Svelte:**
  * Anchor: `vite.config.js`, `vite.config.ts`, `vite.config.mjs`.
  * Inspect plugins inside `vite.config`: `@vitejs/plugin-react`, `@vitejs/plugin-vue`, `@sveltejs/vite-plugin-svelte`.
* **Nuxt:**
  * Anchor: `nuxt.config.ts`, `nuxt.config.js`.
* **Remix / React Router v7:**
  * Anchor: `remix.config.js` or `react-router.config.ts`.
* **SvelteKit:**
  * Anchor: `svelte.config.js`.
* **Astro:**
  * Anchor: `astro.config.mjs`.
* **Angular:**
  * Anchor: `angular.json`.
* **NestJS:**
  * Anchor: `nest-cli.json`, `tsconfig.build.json`.
* **Django:**
  * Anchor: `manage.py`, `settings.py` (with `INSTALLED_APPS`), `wsgi.py`, `asgi.py`.
* **FastAPI:**
  * Anchor: Entry file importing `FastAPI`, `alembic.ini` (if using SQLAlchemy).
* **Flask:**
  * Anchor: `wsgi.py`, `app.py`, `run.py` initializing `Flask(__name__)`.
* **Prisma:**
  * Anchor: `prisma/schema.prisma`.
* **Drizzle:**
  * Anchor: `drizzle.config.ts`, `drizzle.config.js`.

---

### Pass 4: Static AST Code Import & Entrypoint Verification (The 100% Accuracy Seal)

This is the phase that sets this detector apart. Manifests can lie (e.g. forgotten dependencies in `package.json`), but **the AST does not lie**.

#### 1. Python Static Analysis
We execute static AST parsing (using Python's native `ast` module or a dedicated Tree-Sitter grammar):
* **Target Files:** Entry points (`main.py`, `app.py`, `server.py`, `wsgi.py`, `asgi.py`, `manage.py`, `index.py`, or any file under `api/`, `src/`).
* **Patterns Verified:**
  ```python
  # FastAPI Verification
  from fastapi import FastAPI
  app = FastAPI()
  
  # Flask Verification
  from flask import Flask
  app = Flask(__name__)
  
  # Django Verification
  import os
  os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'myproject.settings')
  
  # Tornado Verification
  import tornado.web
  app = tornado.web.Application(...)
  ```
* **Dead Dependency Veto:** If `requirements.txt` lists `fastapi` and `flask`, but the AST scan finds only `from fastapi import FastAPI` across all files, `FastAPI` is confirmed with 100% confidence, and `Flask` is flagged as `UNUSED_DEPENDENCY`.

#### 2. JavaScript / TypeScript Static Analysis
Parse entrypoint files (`main.ts`, `index.ts`, `server.ts`, `src/App.tsx`, `pages/_app.tsx`, `app/layout.tsx`) using AST parsing:
* **Patterns Verified:**
  ```typescript
  // Express Verification
  import express from 'express';
  const app = express();
  
  // NestJS Verification
  import { NestFactory } from '@nestjs/core';
  import { AppModule } from './app.module';
  NestFactory.create(AppModule);
  
  // Fastify Verification
  import Fastify from 'fastify';
  const fastify = Fastify();
  
  // React Verification
  import ReactDOM from 'react-dom/client';
  ReactDOM.createRoot(...);
  
  // Vue Verification
  import { createApp } from 'vue';
  createApp(App).mount('#app');
  ```

---

### Pass 5: Infrastructure & Orchestration Analysis

Modern web applications define their architecture in infrastructure code. We parse:
1. **`docker-compose.yml` / `compose.yaml`:**
   * Extract services (e.g. `web`, `api`, `db`, `redis`, `worker`).
   * Identify base images:
     * `postgres:15` -> Database: PostgreSQL (v15).
     * `mongo:6` -> Database: MongoDB (v6).
     * `redis:alpine` -> Cache/Store: Redis.
     * `mysql:8` -> Database: MySQL (v8).
   * Map port mappings (`3000:3000` -> Frontend, `8000:8000` -> Backend).
   * Track inter-service dependencies (`depends_on: ['db', 'api']`).
2. **`Dockerfile`:**
   * Detect base runtime: `python:3.11-slim`, `node:20-alpine`, `oven/bun:latest`.
   * Extract run commands: `CMD ["uvicorn", "main:app", "--host", "0.0.0.0"]` -> Confirms ASGI/FastAPI backend runtime.
3. **Environment Files (`.env.example`, `.env.template`):**
   * Parse variable keys (never values for security):
     * `DATABASE_URL=postgresql://...` -> PostgreSQL confirmed.
     * `MONGO_URI=mongodb://...` -> MongoDB confirmed.
     * `REDIS_HOST=...` -> Redis confirmed.

---

### Pass 6: 3-Tier Architecture Stitching & Graph Builder

Once individual components and infrastructure services are detected, the engine reconstructs the **3-Tier Topology**:

```
┌─────────────────────────────────────────────────────────────┐
│                    TIER 1: PRESENTATION                     │
│  • Framework: Next.js 14 (App Router)                       │
│  • Component Path: apps/web                                 │
│  • Language: TypeScript                                     │
│  • Port: 3000                                               │
└──────────────────────────────┬──────────────────────────────┘
                               │
               Calls API via `NEXT_PUBLIC_API_URL`
               or Vite proxy / Nginx proxy_pass
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    TIER 2: APPLICATION / API                │
│  • Framework: FastAPI (v0.110.0)                            │
│  • Component Path: apps/api                                 │
│  • Language: Python 3.11                                    │
│  • Entrypoint: apps/api/main.py (app = FastAPI())           │
│  • ORM: SQLAlchemy v2.0 (asyncpg)                           │
│  • Port: 8000                                               │
└──────────────────────────────┬──────────────────────────────┘
                               │
               Connects via `DATABASE_URL` / ORM Models
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    TIER 3: DATA & PERSISTENCE               │
│  • Primary Database: PostgreSQL 16 (from docker-compose)    │
│  • Cache / Queue: Redis 7                                   │
│  • Schema Migrations: Alembic                               │
└─────────────────────────────────────────────────────────────┘
```

#### How the Linkages Are Proven:
1. **Frontend-to-Backend Linkage:**
   * Check for reverse proxy configuration in Frontend (`vite.config.ts` `server.proxy`, `next.config.js` `rewrites()`).
   * Check for shared API client configurations (e.g. `baseURL: process.env.API_URL` or `http://localhost:8000`).
   * Docker Compose `links` or network shared aliases.
2. **Backend-to-Database Linkage:**
   * Backend component imports ORM (`from sqlalchemy.orm import Session` or `import { PrismaClient } from '@prisma/client'`).
   * Backend environment reads `DATABASE_URL`, `POSTGRES_DB`, `MONGO_URI`.
   * Infrastructure file declares DB service matching the driver used in backend.

---

### Pass 7: Conflict Resolution & Disambiguation Matrix

To guarantee "100/100" accuracy, strict precedence and disambiguation rules are enforced:

| Ambiguity / Conflict | Winning Classification | Losing Classification | Grounding Justification |
| :--- | :--- | :--- | :--- |
| `next` + `react` in `package.json` | **Next.js (Fullstack / Meta-framework)** | React (Raw SPA) | Next.js uses React as an internal renderer; elevating Next.js gives true framework semantics. React is retained as `ui_library`. |
| `nuxt` + `vue` in `package.json` | **Nuxt (Meta-framework)** | Vue (Raw SPA) | Same as Next/React. Nuxt is the architectural host. |
| `fastapi` + `starlette` in `requirements.txt` | **FastAPI (Web Framework)** | Starlette (Internal dependency) | FastAPI is built on top of Starlette. Starlette is classified as an underlying engine, not the primary application framework. |
| `flask` in `requirements.txt` but no `Flask` in AST, while `FastAPI` is initialized | **FastAPI** | Flask (marked `UNUSED_OR_LEGACY`) | Static AST execution path proves FastAPI is instantiated; Flask was not pruned from manifest. |
| Root `package.json` has `express` (for testing mock), but `apps/web` has `Next.js` and `apps/api` has `FastAPI` | **Component 1: Next.js**<br>**Component 2: FastAPI** | Express (Root dev-tool) | Component isolation prevents root build scripts from poisoning application tier classification. |
| Monorepo has Next.js API Routes (`app/api/...`) AND a separate FastAPI backend | **Hybrid Multi-Backend** | Single backend | Engine explicitly detects: Frontend Tier = Next.js; Backend Tier = FastAPI (Primary API) + Next.js Route Handlers (BFF - Backend For Frontend). |

---

## 3. Strict Output Schema Specification

The detector produces a machine-readable, deterministic JSON document conforming to the following formal TypeScript interface:

```typescript
export interface TechStackDetectionResult {
  version: "1.0.0";
  timestamp: string;
  repository: {
    structure: "single_component" | "monorepo" | "multi_tier_split" | "microservices";
    monorepo_orchestrator: "pnpm" | "turborepo" | "nx" | "lerna" | "yarn" | "npm" | null;
    total_components_detected: number;
  };
  
  // The Complete 3-Tier Architecture Map
  three_tier_architecture: {
    detected: boolean;
    tier_1_presentation: Tier1Presentation | null;
    tier_2_application: Tier2Application[];
    tier_3_data: Tier3Data[];
  };

  // Discrete Components (frontend app, backend service, shared packages)
  components: DetectedComponent[];

  // Global Infrastructure & Orchestration
  infrastructure: {
    containerization: ("docker" | "docker-compose" | "kubernetes" | "helm")[];
    compose_services: ComposeServiceSummary[];
    environment_variables_detected: string[];
  };

  // Confidence & Verification Evidence Chain
  audit: {
    overall_confidence_score: number; // 0 - 100
    verification_level: "AST_VERIFIED" | "CONFIG_VERIFIED" | "MANIFEST_ONLY";
    warnings: string[];
    dead_dependencies_flagged: string[];
  };
}

export interface Tier1Presentation {
  component_id: string;
  framework: "Next.js" | "Nuxt" | "Remix" | "SvelteKit" | "Astro" | "React" | "Vue" | "Svelte" | "Angular" | "Solid";
  framework_type: "meta_framework_ssr" | "single_page_app" | "static_site";
  router_type?: "next_app_router" | "next_pages_router" | "vue_router" | "react_router" | null;
  ui_library: string | null;
  entrypoint: string;
  build_tool: "vite" | "webpack" | "turbopack" | "next" | "esbuild" | null;
}

export interface Tier2Application {
  component_id: string;
  framework: "FastAPI" | "Django" | "Flask" | "Express" | "NestJS" | "Fastify" | "Hono" | "Litestar" | "Sanic" | "Tornado";
  framework_type: "rest_api" | "graphql_api" | "fullstack_monolith" | "grpc_service";
  runtime: "python" | "nodejs" | "bun" | "deno";
  runtime_version?: string;
  entrypoint: string;
  ast_verified: boolean;
  orm: string | null;
}

export interface Tier3Data {
  engine: "PostgreSQL" | "MySQL" | "MongoDB" | "Redis" | "SQLite" | "Cassandra" | "Elasticsearch";
  role: "primary_database" | "cache" | "queue" | "search_index";
  detected_via: "docker_compose" | "orm_manifest" | "connection_string_env" | "code_import";
  associated_orm_or_driver: string | null;
}

export interface DetectedComponent {
  id: string;
  path: string;
  tier: "presentation" | "application" | "data" | "fullstack" | "shared_lib" | "infrastructure";
  primary_language: "Python" | "TypeScript" | "JavaScript";
  manifest_path: string;
  frameworks: {
    name: string;
    version: string | null;
    role: "primary_framework" | "meta_framework" | "ui_library" | "orm" | "utility";
    confidence: number;
    evidence: {
      manifest_declaration: boolean;
      config_file_present: boolean;
      ast_import_verified: boolean;
      file_path_reference: string;
    };
  }[];
}

export interface ComposeServiceSummary {
  name: string;
  image: string | null;
  ports: string[];
  inferred_tech: string | null;
}
```

---

## 4. Ground Truth Verification Matrix: The 100/100 Evaluation Engine

To guarantee 100% correctness, every component passes through this mathematical confidence evaluation:

$$\text{Confidence Score} = w_m S_m + w_c S_c + w_a S_a + w_i S_i - P_{\text{contradiction}}$$

Where:
* $S_m$ = Manifest Evidence (Presence in `dependencies` / `pyproject.toml`): **20 pts**
* $S_c$ = Config / Anchor Evidence (`next.config.js`, `manage.py`, `nest-cli.json`): **25 pts**
* $S_a$ = Static AST Code Verification (Import + Instantiation detected): **40 pts**
* $S_i$ = Infrastructure & Orchestration Evidence (Port/Command/Image match): **15 pts**
* $P_{\text{contradiction}}$ = Penalty for contradictory signals (e.g. dependency present, but explicit dead code flag): **-50 pts**

A framework is only marked as **PRIMARY** if $\text{Score} \ge 85$ and $S_a = 1$ (AST Verified), or if anchor configuration is unequivocal.

---

## 5. Technical Implementation Roadmap & Work Breakdown

Here is the concrete 6-step roadmap to implement this engine.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                   IMPLEMENTATION ROADMAP (6 PHASES)                      │
└──────────────────────────────────────────────────────────────────────────┘
  [Phase 1] Core Engine & Filesystem Boundary Resolver
    ├── Fast file crawler with ignore rules
    └── Monorepo & multi-tier folder boundary segmenter

  [Phase 2] Manifest & Lockfile Parser Suite
    ├── Python: pyproject.toml, requirements.txt, poetry.lock, uv.lock
    └── JS/TS: package.json, pnpm-lock.yaml, yarn.lock, bun.lockb

  [Phase 3] AST Import & Invocation Analysis Engine
    ├── Python AST visitor (ast.parse)
    └── JS/TS AST visitor (using @babel/parser, oxc-parser, or tree-sitter)

  [Phase 4] Orchestration & Infrastructure Parser
    ├── docker-compose.yml YAML service extractor
    └── Dockerfile & .env symbol analyzer

  [Phase 5] 3-Tier Relationship Stitcher & Conflict Resolution
    ├── Proxy / route / environment correlation engine
    └── Meta-framework elevation and disambiguation rules

  [Phase 6] Benchmark Suite & 100-Archetype Ground Truth Tests
    ├── 50 synthetic test archetypes covering all combos
    └── CI regression harness verifying 100/100 deterministic score
```

### Phase 1: Core Engine & Filesystem Boundary Resolver
* **Task 1.1:** Develop the fast directory walker. Ignore binary files, vendor directories (`node_modules`, `venv`), and build directories (`.next`, `dist`).
* **Task 1.2:** Implement monorepo boundary detection. Detect `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, and root `package.json` workspaces.
* **Task 1.3:** Implement multi-tier folder segmentation. Automatically classify subdirectories named `client`, `frontend`, `web`, `ui` as Presentation candidates; and `api`, `server`, `backend`, `services/*` as Application candidates.

### Phase 2: Manifest & Lockfile Parser Suite
* **Task 2.1:** Implement Python manifest parser:
  * Parse `pyproject.toml` using `tomllib` (Python 3.11+ standard library).
  * Parse `requirements.txt` using a robust parser handling line continuations, `-r` inclusions, and version ranges.
  * Parse `Pipfile`, `poetry.lock`, and `uv.lock`.
* **Task 2.2:** Implement JavaScript manifest parser:
  * Parse `package.json`. Separate `dependencies` from `devDependencies`.
  * Parse `pnpm-lock.yaml`, `yarn.lock`, and `package-lock.json` to obtain pinned versions.

### Phase 3: Static AST Import & Invocation Analysis Engine
* **Task 3.1:** Python AST Scanner:
  * Traverse AST looking for `Import` and `ImportFrom` nodes.
  * Inspect `Call` nodes to find framework instantiations:
    * `FastAPI(...)`
    * `Flask(...)`
    * `tornado.web.Application(...)`
    * `Sanic(...)`
  * Inspect Django `settings.py` for `INSTALLED_APPS` and `MIDDLEWARE`.
* **Task 3.2:** JS/TS AST Scanner:
  * Use a blazing-fast parser (such as `@babel/parser`, `swc`, or `tree-sitter`).
  * Identify `ImportDeclaration` and `require()` calls for `express`, `@nestjs/core`, `fastify`, `hono`, `next`, `react`, `vue`.
  * Verify top-level function calls (`express()`, `NestFactory.create()`, `createApp()`).

### Phase 4: Orchestration & Infrastructure Parser
* **Task 4.1:** Parse `docker-compose.yml` / `compose.yaml`:
  * Map services to tech stacks: database images (`postgres`, `mariadb`, `mongo`, `redis`), backend build contexts, frontend build contexts.
  * Extract port exposures to corroborate tier classifications.
* **Task 4.2:** Parse `Dockerfile` commands:
  * Match base images (`FROM python:...`, `FROM node:...`).
  * Match start commands (`uvicorn`, `gunicorn`, `node`, `next start`, `npm run dev`).
* **Task 4.3:** Parse environment configuration files (`.env.example`):
  * Match connection string prefixes (`postgres://`, `mongodb://`, `redis://`).

### Phase 5: 3-Tier Relationship Stitcher & Conflict Resolution Matrix
* **Task 5.1:** Stitch Presentation to Application Tier:
  * Correlate frontend API base URLs or proxy configurations with backend ports.
* **Task 5.2:** Stitch Application to Data Tier:
  * Correlate backend ORM schemas (e.g. `prisma/schema.prisma` datasource provider or SQLAlchemy models) with database services.
* **Task 5.3:** Execute Disambiguation Matrix:
  * Elevate Next.js/Nuxt over raw React/Vue.
  * Flag dead dependencies that appear in manifests but have 0 AST imports.

### Phase 6: Benchmark Suite & 100-Archetype Ground Truth Tests
* **Task 6.1:** Construct 50 standard test archetypes:
  1. Flat Django Fullstack with Jinja
  2. Django REST Framework + Vite React SPA
  3. FastAPI + Next.js App Router Monorepo (Turborepo)
  4. Express + Vue 3 (PNPM Workspaces) + MongoDB
  5. NestJS + Angular + PostgreSQL + TypeORM
  6. Flask + Vanilla JS + SQLite
  7. Litestar + SvelteKit + Postgres
  8. Microservices: FastAPI + Express + Next.js + Docker Compose
  9. Edge cases: Repo with abandoned Flask dependency but active FastAPI app
  10. Next.js standalone fullstack using Server Actions + Prisma + Postgres
* **Task 6.2:** Build an automated regression test runner asserting that all 50 fixtures score **100% precision and 100% recall** with zero schema deviations.

---

## 6. Implementation Language & Technology Recommendation

To build this tool with maximum portability, speed, and accuracy:
* **Recommended Core Language:** **TypeScript (Node.js or Bun)** or **Python 3.11+**.
  * **Option A: Python 3.11+ Core:**
    * Native `ast` module handles Python code perfectly with zero dependencies.
    * Use `tomllib` (built-in) for `pyproject.toml`.
    * Use Python bindings for `tree-sitter` (`tree-sitter-javascript`, `tree-sitter-typescript`) to parse JS/TS files without needing a Node runtime.
    * Single executable distribution via PyInstaller or uv.
  * **Option B: TypeScript / Node Core:**
    * Native JSON handling and high-speed parsing via `@babel/parser` or `@swc/core`.
    * For Python AST, invoke a lightweight embedded Python script or use `tree-sitter-python`.
* **Recommendation:** If the tool will primarily run in CI/CD or CLI environments, **Python 3.11+ with Tree-sitter** provides the cleanest native parsing of complex Python structures, while easily inspecting JS/TS files at microsecond speed.

---

## 7. Deliverable Schema & Verification Summary

By strictly adhering to this 5-pillar approach (Boundary Resolver -> Manifests -> Anchors -> Static AST -> Orchestration), the system eliminates the guesswork that causes other tools to fail. A project is never guessed—it is **proven through code**.
