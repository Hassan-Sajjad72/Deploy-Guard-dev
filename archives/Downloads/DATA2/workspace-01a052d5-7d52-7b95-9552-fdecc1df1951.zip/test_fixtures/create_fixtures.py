"""
Setup script for sample project fixtures to test tech stack detection.
"""
import os
from pathlib import Path

def create_fixtures():
    base = Path("/home/user/test_fixtures")
    
    # -------------------------------------------------------------
    # Fixture 1: Turborepo Monorepo (Next.js + FastAPI + Postgres)
    # -------------------------------------------------------------
    fix1 = base / "turborepo_3tier"
    (fix1 / "apps" / "web").mkdir(parents=True, exist_ok=True)
    (fix1 / "services" / "api").mkdir(parents=True, exist_ok=True)

    # Monorepo root files
    (fix1 / "turbo.json").write_text('{\n  "$schema": "https://turbo.build/schema.json"\n}', encoding="utf-8")
    (fix1 / "package.json").write_text('{\n  "name": "enterprise-monorepo",\n  "workspaces": ["apps/*", "services/*"]\n}', encoding="utf-8")
    (fix1 / "docker-compose.yml").write_text("""
version: '3.8'
services:
  web:
    build: ./apps/web
    ports:
      - "3000:3000"
    environment:
      - NEXT_PUBLIC_API_URL=http://api:8000
  api:
    build: ./services/api
    ports:
      - "8000:8000"
    depends_on:
      - db
      - cache
    environment:
      - DATABASE_URL=postgresql://user:pass@db:5432/app
  db:
    image: postgres:16-alpine
    ports:
      - "5432:5432"
    environment:
      - POSTGRES_DB=app
  cache:
    image: redis:7-alpine
    ports:
      - "6379:6379"
""", encoding="utf-8")

    # Frontend (Next.js)
    (fix1 / "apps" / "web" / "package.json").write_text("""{
  "name": "web",
  "dependencies": {
    "next": "^14.2.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "tailwindcss": "^3.4.0"
  }
}""", encoding="utf-8")
    (fix1 / "apps" / "web" / "next.config.mjs").write_text("/** @type {import('next').NextConfig} */\nexport default {};\n", encoding="utf-8")
    (fix1 / "apps" / "web" / "app").mkdir(exist_ok=True)
    (fix1 / "apps" / "web" / "app" / "layout.tsx").write_text("export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }", encoding="utf-8")

    # Backend (FastAPI)
    (fix1 / "services" / "api" / "pyproject.toml").write_text("""[project]
name = "api"
version = "0.1.0"
dependencies = [
    "fastapi>=0.110.0",
    "uvicorn>=0.28.0",
    "sqlalchemy>=2.0.0",
    "asyncpg>=0.29.0",
    "alembic>=1.13.0"
]
""", encoding="utf-8")
    (fix1 / "services" / "api" / "alembic.ini").write_text("# Alembic config", encoding="utf-8")
    (fix1 / "services" / "api" / "main.py").write_text("""
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import create_async_engine

app = FastAPI(title="Core API")

@app.get("/health")
def health():
    return {"status": "ok"}
""", encoding="utf-8")

    # -------------------------------------------------------------
    # Fixture 2: Multi-Tier Split (Django REST + Vite React)
    # -------------------------------------------------------------
    fix2 = base / "django_vite_split"
    (fix2 / "frontend").mkdir(parents=True, exist_ok=True)
    (fix2 / "backend").mkdir(parents=True, exist_ok=True)

    # Frontend (Vite + React)
    (fix2 / "frontend" / "package.json").write_text("""{
  "name": "client",
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "axios": "^1.6.0"
  },
  "devDependencies": {
    "vite": "^5.0.0",
    "@vitejs/plugin-react": "^4.2.0"
  }
}""", encoding="utf-8")
    (fix2 / "frontend" / "vite.config.ts").write_text("import { defineConfig } from 'vite';\nexport default defineConfig({});", encoding="utf-8")
    (fix2 / "frontend" / "src").mkdir(exist_ok=True)
    (fix2 / "frontend" / "src" / "App.tsx").write_text("import React from 'react';\nexport default function App() { return <h1>Django + Vite</h1>; }", encoding="utf-8")

    # Backend (Django + DRF)
    (fix2 / "backend" / "requirements.txt").write_text("django>=4.2\ndjangorestframework>=3.14.0\n", encoding="utf-8")
    (fix2 / "backend" / "manage.py").write_text("""#!/usr/bin/env python
import os
import sys

def main():
    os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'myproject.settings')
    try:
        from django.core.management import execute_from_command_line
    except ImportError as exc:
        raise
    execute_from_command_line(sys.argv)

if __name__ == '__main__':
    main()
""", encoding="utf-8")

    print("Fixtures created successfully.")

if __name__ == "__main__":
    create_fixtures()
