# Framework Application Test Collection

This repository contains independent application fixtures covering a variety of web frameworks, runtime architectures, and database combinations.

The complete collection is preserved on the `main` branch.

Each application is also available on its own Git branch. This allows a specific application to be referenced using a normal GitHub repository + branch pair without requiring a separate GitHub repository for every fixture.

GitHub is being used to provide stable, reproducible source-control references for integration, deployment, framework-detection, and compatibility testing.

The applications intentionally vary in:

- framework
- language
- repository layout
- frontend/backend topology
- runtime commands
- environment-variable requirements
- PostgreSQL, MySQL, and MongoDB usage

Applications should be treated as independent projects.

No production credentials should be stored in this repository.

| Branch | Framework | Stack / Architecture | Database |
| --- | --- | --- | --- |
| Angular_Express_MongoDB | Angular | Angular frontend with Express backend | MongoDB |
| Astro_Node_MongoDB | Astro | Astro Node application | MongoDB |
| Astro_Static_Fastify_MySQL | Astro | Astro static frontend with Fastify backend | MySQL |
| CRA_Express_PostgreSQL | Create React App | Create React App frontend with Express backend | PostgreSQL |
| Express_JS_PostgreSQL | Express | Express JavaScript application | PostgreSQL |
| Express_TS_MongoDB | Express | Express TypeScript application | MongoDB |
| Fastify_JS_MySQL | Fastify | Fastify JavaScript application | MySQL |
| Fastify_TS_PostgreSQL | Fastify | Fastify TypeScript application | PostgreSQL |
| NestJS_MongoDB | NestJS | NestJS application | MongoDB |
| NextJS_SSR_PostgreSQL | Next.js | Next.js server-rendered application | PostgreSQL |
| NextJS_Standalone_MongoDB | Next.js | Next.js standalone application | MongoDB |
| NextJS_Static_Express_MySQL | Next.js | Next.js static frontend with Express backend | MySQL |
| Nuxt_SSR_PostgreSQL | Nuxt | Nuxt server-rendered application | PostgreSQL |
| Nuxt_Static_Fastify_MongoDB | Nuxt | Nuxt static frontend with Fastify backend | MongoDB |
| Remix_Node_PostgreSQL | Remix | Remix Node application | PostgreSQL |
| SvelteKit_Node_MySQL | SvelteKit | SvelteKit Node application | MySQL |
| SvelteKit_Static_Express_PostgreSQL | SvelteKit | SvelteKit static frontend with Express backend | PostgreSQL |
| Vite_React_Express_PostgreSQL | Vite React | Vite React frontend with Express backend | PostgreSQL |
| Vite_Vue_Fastify_MySQL | Vite Vue | Vite Vue frontend with Fastify backend | MySQL |
| Webpack_React_Fastify_MongoDB | Webpack React | Webpack React frontend with Fastify backend | MongoDB |
| Django_ASGI_MySQL | Django | Django ASGI application | MySQL |
| Django_WSGI_PostgreSQL | Django | Django WSGI application | PostgreSQL |
| FastAPI_MySQL | FastAPI | FastAPI application | MySQL |
| FastAPI_Nested_PostgreSQL | FastAPI | FastAPI application with nested backend package | PostgreSQL |
| Flask_Factory_MongoDB | Flask | Flask application factory | MongoDB |
| Flask_PostgreSQL | Flask | Flask application | PostgreSQL |
| Streamlit_MongoDB | Streamlit | Streamlit application | MongoDB |
