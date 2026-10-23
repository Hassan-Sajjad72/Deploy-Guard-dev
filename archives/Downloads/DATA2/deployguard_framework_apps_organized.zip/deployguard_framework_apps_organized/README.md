# DeployGuard Test Applications

This ZIP is organized as normal application folders.

## Structure

- `Python_Apps/`
  - `Flask/`
  - `FastAPI/`
  - `Django/`
  - `Streamlit/`

- `JavaScript_Apps/`
  - `Express/`
  - `Fastify/`
  - `NestJS/`
  - `Vite_React/`
  - `Vite_Vue/`
  - `Angular/`
  - `Create_React_App/`
  - `Webpack_React/`
  - `NextJS/`
  - `Nuxt/`
  - `SvelteKit/`
  - `Astro/`
  - `Remix/`

Every final application directory is intended to be opened and tested independently.

Important for DeployGuard testing:
- There are **no Dockerfiles** in the normal fixtures.
- There are **no Docker Compose deployment files** in the normal fixtures.
- DeployGuard must detect the repository and generate its own Docker/build plan.
- Every application contains `.env` and `.env.example`.
- Databases are intentionally varied between PostgreSQL, MySQL, and MongoDB.
- Fixture credentials are local test values only.

Each application has its own README with direct run instructions.
