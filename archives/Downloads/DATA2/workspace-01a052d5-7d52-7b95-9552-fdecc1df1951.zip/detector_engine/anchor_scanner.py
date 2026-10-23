"""
Phase 2: Configuration & Anchor File Verification
Detects specific configuration files and file conventions indicating active frameworks.
"""
from pathlib import Path
from typing import Dict, List, Any
from .models import ComponentInfo

class AnchorScanner:
    def __init__(self, root_dir: Path):
        self.root = root_dir

    def scan_component(self, comp: ComponentInfo) -> Dict[str, Any]:
        comp_dir = self.root / comp.relative_path
        anchors = {}

        # 1. JS / TS Framework Anchors
        if any((comp_dir / f"next.config.{ext}").exists() for ext in ["js", "mjs", "ts"]):
            router = "app_router" if (comp_dir / "app").is_dir() else "pages_router"
            anchors["Next.js"] = {"type": "meta_framework", "router": router}

        if any((comp_dir / f"nuxt.config.{ext}").exists() for ext in ["js", "ts"]):
            anchors["Nuxt"] = {"type": "meta_framework"}

        if any((comp_dir / f"vite.config.{ext}").exists() for ext in ["js", "ts", "mjs"]):
            anchors["Vite"] = {"type": "bundler"}

        if any((comp_dir / f"remix.config.{ext}").exists() for ext in ["js", "ts"]):
            anchors["Remix"] = {"type": "meta_framework"}

        if any((comp_dir / f"svelte.config.{ext}").exists() for ext in ["js", "ts"]):
            anchors["SvelteKit"] = {"type": "meta_framework"}

        if any((comp_dir / f"astro.config.{ext}").exists() for ext in ["mjs", "ts", "js"]):
            anchors["Astro"] = {"type": "meta_framework"}

        if (comp_dir / "angular.json").exists():
            anchors["Angular"] = {"type": "frontend_spa"}

        if (comp_dir / "nest-cli.json").exists():
            anchors["NestJS"] = {"type": "backend_api"}

        # 2. Python Framework Anchors
        if (comp_dir / "manage.py").exists():
            anchors["Django"] = {"type": "fullstack_framework", "file": "manage.py"}

        # Check for ASGI / WSGI
        for f in ["asgi.py", "wsgi.py"]:
            matches = list(comp_dir.rglob(f))
            if matches:
                anchors[f.split(".")[0].upper()] = {"type": "python_gateway", "file": str(matches[0].relative_to(comp_dir))}

        # 3. ORM Anchors
        if (comp_dir / "prisma" / "schema.prisma").exists() or (comp_dir / "schema.prisma").exists():
            anchors["Prisma"] = {"type": "orm"}

        if any((comp_dir / f"drizzle.config.{ext}").exists() for ext in ["ts", "js", "json"]):
            anchors["Drizzle"] = {"type": "orm"}

        if (comp_dir / "alembic.ini").exists():
            anchors["Alembic"] = {"type": "migration_tool"}

        return anchors
