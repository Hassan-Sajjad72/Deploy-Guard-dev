"""
Data models and typed schemas for tech stack detection engine.
"""
from dataclasses import dataclass, field
from typing import List, Dict, Optional, Any

@dataclass
class DependencyInfo:
    name: str
    version_spec: Optional[str] = None
    is_dev: bool = False
    source_manifest: str = ""

@dataclass
class FrameworkEvidence:
    name: str
    category: str # 'frontend_meta', 'frontend_spa', 'backend_api', 'orm', 'ui_library'
    version: Optional[str] = None
    manifest_confirmed: bool = False
    config_confirmed: bool = False
    ast_confirmed: bool = False
    evidence_details: List[str] = field(default_factory=list)
    confidence_score: int = 0 # 0 to 100

@dataclass
class ComponentInfo:
    id: str
    relative_path: str
    role_candidate: str # 'frontend', 'backend', 'fullstack', 'root', 'library'
    primary_language: str # 'Python', 'TypeScript', 'JavaScript', 'Unknown'
    manifests_found: List[str] = field(default_factory=list)
    dependencies: Dict[str, DependencyInfo] = field(default_factory=dict)
    detected_frameworks: List[FrameworkEvidence] = field(default_factory=list)
    entrypoints: List[str] = field(default_factory=list)

@dataclass
class InfrastructureService:
    service_name: str
    image: Optional[str]
    ports: List[str]
    env_vars: List[str]
    inferred_type: str # 'database', 'cache', 'app_backend', 'app_frontend', 'unknown'
    inferred_tech: Optional[str]

@dataclass
class ThreeTierArchitecture:
    presentation_tier: Optional[Dict[str, Any]] = None
    application_tier: List[Dict[str, Any]] = field(default_factory=list)
    data_tier: List[Dict[str, Any]] = field(default_factory=list)
    connections: List[str] = field(default_factory=list)

@dataclass
class RepoTopology:
    structure_type: str # 'single_monolith', 'monorepo', 'multi_tier_split', 'microservices'
    monorepo_orchestrator: Optional[str] = None
    root_path: str = ""
    components: List[ComponentInfo] = field(default_factory=list)
    infrastructure_services: List[InfrastructureService] = field(default_factory=list)
    three_tier: Optional[ThreeTierArchitecture] = None
    audit_warnings: List[str] = field(default_factory=list)
    dead_dependencies: List[str] = field(default_factory=list)
