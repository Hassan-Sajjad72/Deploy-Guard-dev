"""
Phase 1: Manifest & Lockfile Extractor
Parses Python and JS/TS package manifests with direct vs dev dependency distinction.
"""
from pathlib import Path
import json
import re
import tomllib
from typing import Dict
from .models import ComponentInfo, DependencyInfo

class ManifestParser:
    def __init__(self, root_dir: Path):
        self.root = root_dir

    def parse_component_manifests(self, component: ComponentInfo):
        comp_dir = self.root / component.relative_path

        # 1. Check for JS/TS package.json
        pkg_path = comp_dir / "package.json"
        if pkg_path.exists():
            component.manifests_found.append("package.json")
            self._parse_package_json(pkg_path, component)

        # 2. Check for Python pyproject.toml
        pyproject_path = comp_dir / "pyproject.toml"
        if pyproject_path.exists():
            component.manifests_found.append("pyproject.toml")
            self._parse_pyproject(pyproject_path, component)

        # 3. Check for requirements*.txt
        for req_path in comp_dir.glob("requirements*.txt"):
            component.manifests_found.append(req_path.name)
            is_dev = "dev" in req_path.name.lower() or "test" in req_path.name.lower()
            self._parse_requirements_txt(req_path, component, is_dev=is_dev)

        # 4. Check for Pipfile
        pipfile_path = comp_dir / "Pipfile"
        if pipfile_path.exists():
            component.manifests_found.append("Pipfile")
            self._parse_pipfile(pipfile_path, component)

        # Infer component language
        py_count = sum(1 for m in component.manifests_found if m.endswith((".toml", ".txt", "Pipfile", ".py")))
        js_count = sum(1 for m in component.manifests_found if m.endswith(".json"))
        
        # Also check file extensions in folder if ambiguous
        if py_count > js_count:
            component.primary_language = "Python"
        elif js_count > py_count:
            # Check if typescript exists
            ts_files = list(comp_dir.glob("**/*.ts")) + list(comp_dir.glob("**/*.tsx"))
            component.primary_language = "TypeScript" if len(ts_files) > 0 else "JavaScript"
        else:
            component.primary_language = "Unknown"

    def _parse_package_json(self, path: Path, comp: ComponentInfo):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
                
            deps = data.get("dependencies", {})
            for name, spec in deps.items():
                comp.dependencies[name.lower()] = DependencyInfo(
                    name=name,
                    version_spec=str(spec),
                    is_dev=False,
                    source_manifest="package.json"
                )

            dev_deps = data.get("devDependencies", {})
            for name, spec in dev_deps.items():
                if name.lower() not in comp.dependencies:
                    comp.dependencies[name.lower()] = DependencyInfo(
                        name=name,
                        version_spec=str(spec),
                        is_dev=True,
                        source_manifest="package.json"
                    )
        except Exception:
            pass

    def _parse_pyproject(self, path: Path, comp: ComponentInfo):
        try:
            with open(path, "rb") as f:
                data = tomllib.load(f)

            # PEP 621 dependencies
            project = data.get("project", {})
            for dep in project.get("dependencies", []):
                self._add_py_dep_string(dep, comp, is_dev=False, source="pyproject.toml")

            # Poetry dependencies
            poetry = data.get("tool", {}).get("poetry", {})
            for dep, spec in poetry.get("dependencies", {}).items():
                if dep.lower() != "python":
                    comp.dependencies[dep.lower()] = DependencyInfo(
                        name=dep,
                        version_spec=str(spec) if isinstance(spec, str) else None,
                        is_dev=False,
                        source_manifest="pyproject.toml[poetry]"
                    )

            for dep, spec in poetry.get("group", {}).get("dev", {}).get("dependencies", {}).items():
                if dep.lower() not in comp.dependencies:
                    comp.dependencies[dep.lower()] = DependencyInfo(
                        name=dep,
                        version_spec=str(spec) if isinstance(spec, str) else None,
                        is_dev=True,
                        source_manifest="pyproject.toml[poetry.dev]"
                    )
        except Exception:
            pass

    def _parse_requirements_txt(self, path: Path, comp: ComponentInfo, is_dev: bool):
        try:
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or line.startswith("-"):
                        continue
                    self._add_py_dep_string(line, comp, is_dev=is_dev, source=path.name)
        except Exception:
            pass

    def _parse_pipfile(self, path: Path, comp: ComponentInfo):
        try:
            with open(path, "rb") as f:
                data = tomllib.load(f)
            packages = data.get("packages", {})
            for pkg, spec in packages.items():
                comp.dependencies[pkg.lower()] = DependencyInfo(
                    name=pkg,
                    version_spec=str(spec),
                    is_dev=False,
                    source_manifest="Pipfile"
                )
        except Exception:
            pass

    def _add_py_dep_string(self, dep_line: str, comp: ComponentInfo, is_dev: bool, source: str):
        # Extract package name: e.g. fastapi[all]>=0.100.0 -> fastapi
        match = re.match(r"^([a-zA-Z0-9_\-\.]+)(?:\[.*?\])?(.*)$", dep_line.strip())
        if match:
            pkg_name = match.group(1).lower()
            spec = match.group(2).strip() or None
            # Only overwrite if not already marked as prod dep
            if pkg_name not in comp.dependencies or not is_dev:
                comp.dependencies[pkg_name] = DependencyInfo(
                    name=pkg_name,
                    version_spec=spec,
                    is_dev=is_dev,
                    source_manifest=source
                )
