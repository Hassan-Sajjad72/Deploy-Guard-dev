"""
Phase 4: Infrastructure & Orchestration Grapher
Extracts container services, ports, databases, and runtime environments.
"""
from pathlib import Path
import yaml
import re
from typing import List, Dict, Any
from .models import InfrastructureService

DB_IMAGE_PATTERNS = {
    "postgres": ("PostgreSQL", "database"),
    "postgresql": ("PostgreSQL", "database"),
    "mysql": ("MySQL", "database"),
    "mariadb": ("MariaDB", "database"),
    "mongo": ("MongoDB", "database"),
    "redis": ("Redis", "cache"),
    "cassandra": ("Cassandra", "database"),
    "elasticsearch": ("Elasticsearch", "search_index")
}

class InfraOrchestrator:
    def __init__(self, root_dir: Path):
        self.root = root_dir

    def scan(self) -> List[InfrastructureService]:
        services: List[InfrastructureService] = []

        # 1. Parse Docker Compose
        compose_files = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]
        for f_name in compose_files:
            p = self.root / f_name
            if p.exists():
                services.extend(self._parse_compose(p))

        return services

    def _parse_compose(self, path: Path) -> List[InfrastructureService]:
        results = []
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f)
                if not isinstance(data, dict):
                    return results

            compose_services = data.get("services", {})
            for svc_name, svc_conf in compose_services.items():
                if not isinstance(svc_conf, dict):
                    continue

                image = svc_conf.get("image", "")
                ports = [str(port) for port in svc_conf.get("ports", [])]
                
                # Extract env vars
                env = svc_conf.get("environment", {})
                env_keys = []
                if isinstance(env, dict):
                    env_keys = list(env.keys())
                elif isinstance(env, list):
                    env_keys = [e.split("=")[0] for e in env if isinstance(e, str)]

                # Determine tech and type
                inferred_type = "unknown"
                inferred_tech = None

                if image:
                    img_lower = image.lower()
                    for pattern, (tech_name, tech_type) in DB_IMAGE_PATTERNS.items():
                        if pattern in img_lower:
                            inferred_type = tech_type
                            inferred_tech = tech_name
                            break

                # Infer from service name if image was local build
                if not inferred_tech:
                    s_lower = svc_name.lower()
                    for pattern, (tech_name, tech_type) in DB_IMAGE_PATTERNS.items():
                        if pattern in s_lower:
                            inferred_type = tech_type
                            inferred_tech = tech_name
                            break

                results.append(InfrastructureService(
                    service_name=svc_name,
                    image=image if image else None,
                    ports=ports,
                    env_vars=env_keys,
                    inferred_type=inferred_type,
                    inferred_tech=inferred_tech
                ))

        except Exception:
            pass

        return results
