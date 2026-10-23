# DeployGuard JavaScript and Python Web Framework Combination Report

**Purpose:** define the largest practical framework-detection catalogue for a container-based PaaS, compare it with DeployGuard's uploaded detector, and calculate the resulting support/test combinations.

## 1. Important definition

There is no finite absolute total for *all possible* JavaScript and Python web applications. Developers can create custom frameworks, custom start commands, plugins, wrappers, monorepos, runtime versions, and Dockerfiles. The true universe is therefore unbounded.

This report uses a **practical maximum catalogue**: actively recognizable framework/runtime families that a general-purpose JS/Python container PaaS may reasonably encounter. It excludes desktop/mobile-only applications and treats materially different deployment modes—such as static versus SSR, WSGI versus ASGI, and direct app object versus application factory—as separate variants.

## 2. Headline totals

| Measure | Total |
|---|---:|
| JavaScript/TypeScript framework-runtime variants | **50** |
| Python framework-runtime variants | **40** |
| Practical framework-runtime catalogue | **90** |
| JS framework × package-manager combinations (50 × 4) | **200** |
| Python framework × dependency-manager combinations (40 × 6) | **240** |
| Framework × manager combinations | **440** |
| Upper-bound matrix after 3 layouts × 4 DB modes × 2 storage modes × 2 build lanes | **21,120** |

The **21,120** figure is a synthetic upper bound, not a claim that every cross-product is valid. For example, a purely static SPA does not normally need a database or persistent filesystem. Runtime versions, plugins, environment-variable patterns, and custom commands would make the real state space much larger and effectively unbounded.

## 3. JavaScript/TypeScript catalogue — 50 variants

| # | Category | Framework/runtime variant | Deployment shape | Priority for automatic detection |
|---:|---|---|---|---|
| 1 | Static/SPA | React + Vite | static | High |
| 2 | Static/SPA | Vue + Vite | static | High |
| 3 | Static/SPA | Svelte + Vite | static | High |
| 4 | Static/SPA | Solid + Vite | static | Medium |
| 5 | Static/SPA | Preact + Vite | static | Medium |
| 6 | Static/SPA | Lit + Vite | static | Medium |
| 7 | Static/SPA | Vanilla Vite | static | High |
| 8 | Static/SPA | Angular | static | High |
| 9 | Static/SPA | Ember | static | Low |
| 10 | Static/SPA | Create React App (legacy) | static | Legacy |
| 11 | Static/SPA | Docusaurus | static | Medium |
| 12 | Static/SPA | Eleventy | static | Medium |
| 13 | SSR/full-stack | Next.js Node SSR | node server | High |
| 14 | SSR/full-stack | Next.js static export | static | High |
| 15 | SSR/full-stack | Nuxt Node SSR | node server | High |
| 16 | SSR/full-stack | Nuxt static/prerender | static | High |
| 17 | SSR/full-stack | SvelteKit adapter-node | node server | High |
| 18 | SSR/full-stack | SvelteKit adapter-static | static | High |
| 19 | SSR/full-stack | Astro Node SSR | node server | High |
| 20 | SSR/full-stack | Astro static | static | High |
| 21 | SSR/full-stack | Remix Node | node server | Medium |
| 22 | SSR/full-stack | Gatsby SSR | node server | Medium |
| 23 | SSR/full-stack | Gatsby static | static | Medium |
| 24 | SSR/full-stack | SolidStart Node | node server | Medium |
| 25 | SSR/full-stack | Qwik City Node | node server | Medium |
| 26 | SSR/full-stack | TanStack Start Node | node server | Medium |
| 27 | SSR/full-stack | Analog | node server | Low |
| 28 | SSR/full-stack | RedwoodJS | multi-process/full-stack | Low |
| 29 | SSR/full-stack | Meteor | node server | Low |
| 30 | SSR/full-stack | Fresh | Deno server | Low |
| 31 | Backend/API | Express | node server | High |
| 32 | Backend/API | Fastify | node server | High |
| 33 | Backend/API | NestJS | node server | High |
| 34 | Backend/API | Koa | node server | Medium |
| 35 | Backend/API | hapi | node server | Medium |
| 36 | Backend/API | AdonisJS | node server | Medium |
| 37 | Backend/API | Hono on Node | node server | Medium |
| 38 | Backend/API | Hono on Bun | Bun server | Low |
| 39 | Backend/API | Hono on Deno | Deno server | Low |
| 40 | Backend/API | FeathersJS | node server | Medium |
| 41 | Backend/API | LoopBack | node server | Low |
| 42 | Backend/API | Sails.js | node server | Low |
| 43 | Backend/API | Restify | node server | Low |
| 44 | Backend/API | Polka | node server | Low |
| 45 | Backend/API | Oak | Deno server | Low |
| 46 | Backend/API | Elysia | Bun server | Low |
| 47 | CMS/platform | Strapi | node server | Medium |
| 48 | CMS/platform | KeystoneJS | node server | Low |
| 49 | CMS/platform | Payload CMS | node server | Medium |
| 50 | CMS/platform | Directus source deployment | node server | Low |

## 4. Python catalogue — 40 variants

| # | Category | Framework/runtime variant | Deployment shape | Priority for automatic detection |
|---:|---|---|---|---|
| 1 | Full-stack/API | Django WSGI | WSGI | High |
| 2 | Full-stack/API | Django ASGI | ASGI | High |
| 3 | Full-stack/API | Flask direct app object | WSGI | High |
| 4 | Full-stack/API | Flask application factory | WSGI factory | High |
| 5 | Full-stack/API | FastAPI direct app object | ASGI | High |
| 6 | Full-stack/API | FastAPI application factory | ASGI factory | High |
| 7 | Full-stack/API | Starlette | ASGI | Medium |
| 8 | Full-stack/API | Litestar | ASGI | Medium |
| 9 | Full-stack/API | Sanic | ASGI/server | Medium |
| 10 | Full-stack/API | aiohttp | async server | Medium |
| 11 | Full-stack/API | Tornado | async server | Medium |
| 12 | Full-stack/API | Pyramid | WSGI | Low |
| 13 | Full-stack/API | Bottle | WSGI | Low |
| 14 | Full-stack/API | Falcon WSGI | WSGI | Medium |
| 15 | Full-stack/API | Falcon ASGI | ASGI | Medium |
| 16 | Full-stack/API | Quart | ASGI | Medium |
| 17 | Full-stack/API | CherryPy | WSGI/server | Low |
| 18 | Full-stack/API | web2py | WSGI | Low |
| 19 | Full-stack/API | Masonite | WSGI/ASGI | Low |
| 20 | Full-stack/API | BlackSheep | ASGI | Low |
| 21 | Django ecosystem | Django Ninja | Django ASGI/WSGI | Medium |
| 22 | Django ecosystem | Django REST Framework | Django ASGI/WSGI | High |
| 23 | API layer | Connexion WSGI | WSGI | Low |
| 24 | API layer | Connexion ASGI | ASGI | Low |
| 25 | API layer | Eve | WSGI | Low |
| 26 | Data/UI | Streamlit | specialized server | High |
| 27 | Data/UI | Dash | Flask/WSGI | Medium |
| 28 | Data/UI | Gradio | ASGI/server | Medium |
| 29 | Data/UI | Panel | Bokeh server | Low |
| 30 | Data/UI | Bokeh Server | specialized server | Low |
| 31 | Data/UI | Reflex | full-stack Python | Medium |
| 32 | Data/UI | NiceGUI | ASGI/server | Medium |
| 33 | Data/UI | Voilà | Jupyter server | Low |
| 34 | Data/UI | Shiny for Python | specialized server | Low |
| 35 | Data/UI | FastHTML | ASGI | Low |
| 36 | Data/UI | Solara | specialized server | Low |
| 37 | CMS/data | Wagtail | Django WSGI/ASGI | Medium |
| 38 | CMS/data | django CMS | Django WSGI/ASGI | Low |
| 39 | CMS/data | Datasette | ASGI/server | Medium |
| 40 | CMS/data | Mezzanine | Django WSGI | Low |

## 5. Combination dimensions

### JavaScript build managers

npm, pnpm, Yarn, Bun.

### Python dependency managers

pip/requirements, Poetry, Pipenv, uv, PDM, Hatch.

### Repository layouts used in the upper-bound count

1. Application at repository root.
2. Application in a selected subdirectory.
3. Workspace/monorepo with a root lockfile and one selected application.

### Database modes used in the upper-bound count

1. No database.
2. Managed PostgreSQL.
3. Managed MySQL.
4. External database reference.

### Storage modes

1. Stateless/ephemeral.
2. Persistent filesystem required.

### Build lanes

1. DeployGuard-generated container.
2. Repository Dockerfile.

## 6. What the uploaded DeployGuard detector currently recognizes

The uploaded source archive contains dedicated automatic template variants for:

### JavaScript — 7 named variants

1. Next.js SSR
2. Next.js static export
3. Express
4. NestJS
5. Fastify
6. Vite static
7. React static

### Python — 4 named variants

1. Django WSGI
2. FastAPI ASGI
3. Flask WSGI
4. Streamlit

Therefore DeployGuard currently has **11 named automatic framework variants**. It also has `generic-node` and `generic-python` fallback templates, but those must not be counted as reliable framework support because an unknown Node or Python repository can reach them without a proven production start contract.

### Current coverage against this practical catalogue

- Named automatic variants: **11 of 90** = **12.2%**.
- Named JavaScript variants: **7 of 50** = **14.0%**.
- Named Python variants: **4 of 40** = **10.0%**.

This percentage is not a product-quality score. Many unrecognized frameworks can still deploy safely through a repository Dockerfile. It measures only dedicated automatic detection/template coverage.

## 7. Important current detector flaws

1. **Generic fallbacks are marked successful.** Unknown Node and Python repositories can select `generic-node` or `generic-python` instead of being blocked for explicit configuration.
2. **All Vite projects are labeled as `vite-react`.** Vue, Svelte, Solid, Preact, Lit, and vanilla Vite are misclassified even when their static output might build correctly.
3. **React detection is too broad.** A React dependency plus a build script can misclassify Remix, Gatsby, Electron, or custom SSR projects as a static React application.
4. **FastAPI factories are not reliably detected.** Patterns such as `create_app()` and Uvicorn `--factory` require explicit handling.
5. **Flask factories are not reliably detected.** Factory imports and CLI-based app discovery need a distinct variant.
6. **Django supports only one generated WSGI path.** ASGI, multiple settings modules, and unusual project roots are not fully handled.
7. **Streamlit entry-point detection is narrow.** It mainly accepts `app.py` or `main.py`; common names such as `streamlit_app.py` or nested dashboards can be missed.
8. **Workspace lockfiles are incomplete.** A nested app may use a valid root-level npm/pnpm/Yarn lockfile that the selected app directory does not contain.
9. **Python manager coverage is incomplete.** `uv`, PDM, and Hatch are not identified as first-class dependency managers.
10. **Regular-expression inference cannot prove arbitrary application behavior.** Ambiguous cases must fail closed or require overrides/custom Dockerfile.

## 8. Recommended DeployGuard support strategy

Trying to create 90 custom automatic templates is the wrong goal. A reliable PaaS should support deployment **shapes**, not hand-code every framework name.

### Shape A — static output

Detect a deterministic build command and output directory, then serve immutable static files. This single adapter can cover React/Vite, Vue/Vite, Svelte/Vite, Solid/Vite, Preact/Vite, Angular, Astro static, Nuxt static, SvelteKit static, Docusaurus, Eleventy, and similar projects.

### Shape B — Node HTTP server

Require a production build, a deterministic production start command, `PORT`, and binding to `0.0.0.0`. This covers Next.js SSR, Nuxt SSR, SvelteKit Node, Astro Node, Remix, Express, Fastify, NestJS, Koa, hapi, AdonisJS, and many others.

### Shape C — Python WSGI

Require a resolvable WSGI import target and production server. This covers Django WSGI, Flask, Pyramid, Bottle, Falcon WSGI, Connexion WSGI, and related frameworks.

### Shape D — Python ASGI

Require a resolvable ASGI import target or factory and a production ASGI server. This covers Django ASGI, FastAPI, Starlette, Litestar, Quart, Falcon ASGI, BlackSheep, and related frameworks.

### Shape E — specialized Python UI server

Use explicit adapters for Streamlit, Dash, Gradio, Panel/Bokeh, Reflex, NiceGUI, Voilà, and Shiny because their health paths, WebSocket behavior, ports, and startup commands differ.

### Shape F — repository Dockerfile

Use for Deno/Bun-specific applications, CMS platforms, complex monorepos, custom native dependencies, multi-process projects, and unsupported frameworks. Validate that the image is non-root where possible, exposes one HTTP port, binds publicly, has a health endpoint, and starts reproducibly.

## 9. Realistic automatic-support target

For DeployGuard's MVP, the best target is not all 90 variants. The recommended target is:

- **Tier 1, dedicated and fully tested: 17 variants** — generic Vite static with framework metadata; Next.js SSR/static; Nuxt SSR/static; Express; NestJS; Fastify; Django WSGI/ASGI; FastAPI direct/factory; Flask direct/factory; Streamlit; Starlette.
- **Tier 2, shape-based with explicit command verification: about 25 additional variants.**
- **Tier 3, repository Dockerfile only: the remaining complex, specialized, Deno/Bun, CMS, and multi-process variants.**

This gives broad real-world coverage without pretending that regex-based framework-name detection can understand every repository.

## 10. Testing recommendation

Do not run all 21,120 combinations. Use a risk-based matrix:

1. One golden fixture for every dedicated Tier 1 variant.
2. Every supported package/dependency manager at least once.
3. Root, nested, and workspace layouts.
4. Direct object and factory import patterns.
5. Static, Node server, WSGI, ASGI, and specialized UI runtime shapes.
6. No database, PostgreSQL, MySQL, and external database reference.
7. Stateless and persistent-storage cases.
8. Positive and negative fixtures, including ambiguous roots, missing lockfiles, development commands, localhost binding, missing `PORT`, and unsupported runtimes.
9. Build image, start container, probe health, stop it, and repeat startup.
10. Certify the whole detector/template/workflow bundle before activation.

A strong pairwise/risk-based suite would normally require roughly **100–150 carefully selected fixtures**, rather than thousands of full cross-product deployments.

## 11. Final answer

- Absolute universal total: **unbounded**.
- Practical framework/runtime catalogue in this report: **90 variants**.
- Framework × package/dependency-manager combinations: **440**.
- Synthetic upper-bound matrix used for planning: **21,120 combinations**.
- Current DeployGuard dedicated automatic variants: **11**.
- Current dedicated automatic coverage of this catalogue: **12.2%**.
- Recommended reliable MVP target: **17 fully certified variants**, broader shape-based support, and Dockerfile fallback for the rest.

## 12. Source basis

Code basis: the uploaded DeployGuard detection archive containing `stack-detection.service.ts`, `template-matching.service.ts`, `repo-deployability-scanner.service.ts`, `repository-workspace.service.ts`, and `deployment-profile.service.ts`.

External technical basis: official deployment documentation for Next.js self-hosting, Vite static deployments, Nuxt Node/static deployment, Django WSGI/ASGI deployment, FastAPI production server execution, and Streamlit Docker deployment.