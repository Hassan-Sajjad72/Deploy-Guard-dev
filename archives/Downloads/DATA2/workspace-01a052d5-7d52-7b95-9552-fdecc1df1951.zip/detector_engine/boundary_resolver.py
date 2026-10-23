"""
Phase 0: Workspace Boundary & Repo Topology Resolver
Discovers repository boundaries, monorepo orchestrators, and isolates components.
"""
from pathlib import Path
import json
import yaml
from typing import List, Dict, Tuple, Set
from .models import ComponentInfo

IGNORE_DIRS = {
    ".git", ".svn", ".hg", "node_modules", "venv", ".venv", "env",
    "__pycache__", ".pytest_cache", ".next", ".nuxt", "dist", "build",
    "out", "coverage", ".turbo", ".idea", ".vscode", "target"
}

FRONTEND_KEYWORDS = {"frontend", "client", "web", "ui", "spa", "app", "site"}
BACKEND_KEYWORDS = {"backend", "server", "api", "core", "services", "service"}

class BoundaryResolver:
    def __init__(self, root_dir: str):
        self.root = Path(root_dir).resolve()

    def resolve(self) -> Tuple[str, str | None, List[ComponentInfo]]:
        """
        Returns:
            (structure_type, monorepo_orchestrator, components)
        """
        orchestrator = self._detect_monorepo_orchestrator()
        
        # Discover all subdirectories with manifest files
        candidate_paths = self._find_manifest_directories()

        if orchestrator or len(candidate_paths) > 1:
            # Monorepo or multi-tier split
            structure = "monorepo" if orchestrator else "multi_tier_split"
            components = self._create_components(candidate_paths)
            return structure, orchestrator, components
        elif len(candidate_paths) == 1:
            # Single project rooted at root or child
            components = self._create_components(candidate_paths)
            return "single_monolith", None, components
        else:
            # Fallback for repository with files directly in root
            root_comp = ComponentInfo(
                id="root",
                relative_path=".",
                role_candidate="fullstack",
                primary_language="Unknown"
            )
            return "single_monolith", None, [root_comp]

    def _detect_monorepo_orchestrator(self) -> str | None:
        if (self.root / "pnpm-workspace.yaml").exists():
            return "pnpm"
        if (self.root / "turbo.json").exists():
            return "turborepo"
        if (self.root / "nx.json").exists():
            return "nx"
        if (self.root / "lerna.json").exists():
            return "lerna"
        
        pkg_json = self.root / "package.json"
        if pkg_json.exists():
            try:
                with open(pkg_json, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if "workspaces" in data:
                        return "npm_yarn_workspaces"
            except Exception:
                pass
        return None

    def _find_manifest_directories(self) -> List[Path]:
        """Finds all directories containing package manifests, respecting ignore rules."""
        manifest_dirs: Set[Path] = set()
        manifest_names = {
            "package.json", "pyproject.toml", "requirements.txt",
            "Pipfile", "setup.py", "manage.py"
        }

        for path in self.root.rglob("*"):
            if path.is_file() and path.name in manifest_names:
                # Check if any parent part is in IGNORE_DIRS
                rel = path.relative_to(self.root)
                parts = rel.parts[:-1]
                if any(p in IGNORE_DIRS for p in parts):
                    continue
                # Directory of manifest
                manifest_dirs.add(path.parent)

        sorted_dirs = sorted(list(manifest_dirs), key=lambda p: len(p.parts))
        
        # If root has manifests but also distinct sub-apps, keep root only if it's not purely a workspace orchestrator
        return sorted_dirs

    def _create_components(self, paths: List[Path]) -> List[ComponentInfo]:
        components = []
        for p in paths:
            rel = p.relative_to(self.root)
            rel_str = "." if str(rel) == "." else str(rel)
            comp_id = rel_str.replace("/", "_").replace("\\", "_")
            if comp_id == ".":
                comp_id = "root"

            # Determine role candidate based on path name
            parts_lower = [part.lower() for part in p.parts]
            role = "unknown"
            if any(k in parts_lower for k in FRONTEND_KEYWORDS):
                role = "frontend"
            elif any(k in parts_lower for k in BACKEND_KEYWORDS):
                role = "backend"
            elif comp_id == "root":
                role = "root"

            comp = ComponentInfo(
                id=comp_id,
                relative_path=rel_str,
                role_candidate=role,
                primary_language="Unknown"
            )
            components.append(comp)
        return components
