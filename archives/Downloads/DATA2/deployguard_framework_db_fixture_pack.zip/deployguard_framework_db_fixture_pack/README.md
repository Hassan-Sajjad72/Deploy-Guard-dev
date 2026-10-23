# DeployGuard Framework + Database Fixture Pack

Contains **27 minimal repository fixtures**, ordered Python first then JavaScript/TypeScript.

Every fixture includes required environment evidence (`.env` and `.env.example`) and rotates PostgreSQL, MySQL, and MongoDB. Frontend-only/static frameworks are paired with a minimal backend so the database is owned by a server component rather than incorrectly embedded in browser code.

Use each directory as an independent repository fixture. Typical local run: `docker compose up --build`. See `MATRIX.csv`.

Validation performed during generation: JSON parse, Python compile, required-file checks, and manifest checks. Full dependency installation / Docker execution was not run in this generation environment; run `python validate_pack.py` first and then use DeployGuard/Codex for executable certification.
