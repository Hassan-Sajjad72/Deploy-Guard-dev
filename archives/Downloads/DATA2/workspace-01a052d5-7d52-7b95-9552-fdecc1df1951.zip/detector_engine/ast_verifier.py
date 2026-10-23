"""
Phase 3: Static AST Import & Entrypoint Verification Engine
Performs deep static code inspection to prove framework execution and eliminate false positives.
"""
from pathlib import Path
import ast
import re
from typing import Dict, List, Set, Any
from .models import ComponentInfo

# Max files to AST inspect per component to maintain ultra-fast performance
MAX_AST_FILES = 40

class ASTVerifier:
    def __init__(self, root_dir: Path):
        self.root = root_dir

    def verify_component(self, comp: ComponentInfo) -> Dict[str, Dict[str, Any]]:
        comp_dir = self.root / comp.relative_path
        results = {}

        if comp.primary_language == "Python":
            results = self._verify_python(comp_dir, comp)
        elif comp.primary_language in ("JavaScript", "TypeScript"):
            results = self._verify_javascript(comp_dir, comp)
        else:
            # Try both if unknown
            py_res = self._verify_python(comp_dir, comp)
            js_res = self._verify_javascript(comp_dir, comp)
            results = {**py_res, **js_res}

        return results

    def _verify_python(self, comp_dir: Path, comp: ComponentInfo) -> Dict[str, Dict[str, Any]]:
        verified = {}
        py_files = []
        
        # Priority entry points first
        for name in ["main.py", "app.py", "server.py", "wsgi.py", "asgi.py", "manage.py"]:
            candidate = comp_dir / name
            if candidate.exists():
                py_files.append(candidate)

        for p in comp_dir.rglob("*.py"):
            if len(py_files) >= MAX_AST_FILES:
                break
            if p not in py_files and not any(part.startswith(".") or part in ("tests", "test") for part in p.parts):
                py_files.append(p)

        for file_path in py_files:
            try:
                with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                    tree = ast.parse(f.read(), filename=str(file_path))
                
                rel_file = str(file_path.relative_to(self.root))
                
                for node in ast.walk(tree):
                    # Check imports
                    if isinstance(node, ast.Import):
                        for alias in node.names:
                            self._check_py_module(alias.name, rel_file, verified)
                    elif isinstance(node, ast.ImportFrom):
                        if node.module:
                            self._check_py_module(node.module, rel_file, verified)
                    
                    # Check instantiations
                    if isinstance(node, ast.Call):
                        func_name = self._get_call_name(node.func)
                        if func_name:
                            if func_name in ("FastAPI", "fastapi.FastAPI"):
                                verified.setdefault("FastAPI", {})["instantiated"] = True
                                verified["FastAPI"]["entrypoint"] = rel_file
                            elif func_name in ("Flask", "flask.Flask"):
                                verified.setdefault("Flask", {})["instantiated"] = True
                                verified["Flask"]["entrypoint"] = rel_file
                            elif func_name in ("Sanic", "sanic.Sanic"):
                                verified.setdefault("Sanic", {})["instantiated"] = True
                                verified["Sanic"]["entrypoint"] = rel_file
                            elif "Application" in func_name and "tornado" in func_name:
                                verified.setdefault("Tornado", {})["instantiated"] = True
                                verified["Tornado"]["entrypoint"] = rel_file

            except Exception:
                continue

        return verified

    def _check_py_module(self, mod_name: str, file_path: str, verified: Dict[str, Dict[str, Any]]):
        mod_lower = mod_name.lower()
        if "fastapi" in mod_lower:
            v = verified.setdefault("FastAPI", {"imported": True, "files": []})
            v["files"].append(file_path)
        elif "flask" in mod_lower and not "flask_cors" in mod_lower:
            v = verified.setdefault("Flask", {"imported": True, "files": []})
            v["files"].append(file_path)
        elif "django" in mod_lower:
            v = verified.setdefault("Django", {"imported": True, "files": []})
            v["files"].append(file_path)
        elif "tornado" in mod_lower:
            v = verified.setdefault("Tornado", {"imported": True, "files": []})
            v["files"].append(file_path)
        elif "sanic" in mod_lower:
            v = verified.setdefault("Sanic", {"imported": True, "files": []})
            v["files"].append(file_path)
        elif "sqlalchemy" in mod_lower:
            v = verified.setdefault("SQLAlchemy", {"imported": True, "files": []})
            v["files"].append(file_path)
        elif "tortoise" in mod_lower:
            v = verified.setdefault("Tortoise-ORM", {"imported": True, "files": []})
            v["files"].append(file_path)

    def _get_call_name(self, node: ast.AST) -> str | None:
        if isinstance(node, ast.Name):
            return node.id
        elif isinstance(node, ast.Attribute):
            val = self._get_call_name(node.value)
            return f"{val}.{node.attr}" if val else node.attr
        return None

    def _verify_javascript(self, comp_dir: Path, comp: ComponentInfo) -> Dict[str, Dict[str, Any]]:
        verified = {}
        js_files = []

        # Priority files
        for name in ["main.ts", "main.tsx", "main.js", "main.jsx", "index.ts", "index.js", "server.ts", "server.js", "App.tsx", "App.vue"]:
            candidates = list(comp_dir.rglob(name))
            js_files.extend(candidates[:2])

        for p in comp_dir.rglob("*"):
            if len(js_files) >= MAX_AST_FILES:
                break
            if p.suffix in (".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte", ".astro"):
                if p not in js_files and not any(part.startswith(".") or part in ("tests", "__tests__") for part in p.parts):
                    js_files.append(p)

        for file_path in js_files:
            try:
                content = file_path.read_text(encoding="utf-8", errors="ignore")
                rel_file = str(file_path.relative_to(self.root))

                # Express check
                if re.search(r"import\s+.*\bexpress\b|require\(['\"]express['\"]\)", content):
                    v = verified.setdefault("Express", {"imported": True, "files": []})
                    v["files"].append(rel_file)
                    if re.search(r"express\(\)", content):
                        v["instantiated"] = True
                        v["entrypoint"] = rel_file

                # NestJS check
                if "@nestjs/core" in content or "@nestjs/common" in content:
                    v = verified.setdefault("NestJS", {"imported": True, "files": []})
                    v["files"].append(rel_file)
                    if "NestFactory.create" in content:
                        v["instantiated"] = True
                        v["entrypoint"] = rel_file

                # Fastify check
                if re.search(r"import\s+.*\bfastify\b|require\(['\"]fastify['\"]\)", content):
                    v = verified.setdefault("Fastify", {"imported": True, "files": []})
                    v["files"].append(rel_file)
                    if re.search(r"fastify\(\)", content):
                        v["instantiated"] = True

                # Hono check
                if "hono" in content:
                    if re.search(r"new\s+Hono\(", content):
                        v = verified.setdefault("Hono", {"imported": True, "instantiated": True, "files": []})
                        v["files"].append(rel_file)

                # React check
                if re.search(r"import\s+.*\bfrom\s+['\"]react['\"]|createRoot|ReactDOM", content):
                    v = verified.setdefault("React", {"imported": True, "files": []})
                    v["files"].append(rel_file)

                # Vue check
                if re.search(r"import\s+.*\bfrom\s+['\"]vue['\"]|createApp\(", content):
                    v = verified.setdefault("Vue", {"imported": True, "files": []})
                    v["files"].append(rel_file)

                # Svelte check
                if file_path.suffix == ".svelte" or "svelte" in content:
                    v = verified.setdefault("Svelte", {"imported": True, "files": []})
                    v["files"].append(rel_file)

            except Exception:
                continue

        return verified
