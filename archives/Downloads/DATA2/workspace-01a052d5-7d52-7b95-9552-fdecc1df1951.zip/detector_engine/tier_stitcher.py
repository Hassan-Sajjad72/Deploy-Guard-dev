"""
Phase 5: 3-Tier Stitcher & Disambiguation Consensus Engine
Combines multi-layer evidence, resolves framework conflicts, and outputs the unified architecture.
"""
from typing import List, Dict, Any, Optional
from .models import (
    ComponentInfo, FrameworkEvidence, InfrastructureService,
    ThreeTierArchitecture, RepoTopology
)

class TierStitcher:
    def __init__(self, topology: RepoTopology):
        self.topo = topology

    def stitch(self) -> Dict[str, Any]:
        three_tier = ThreeTierArchitecture()
        
        presentation_candidates = []
        application_candidates = []
        data_tier_items = []

        # 1. Process infrastructure databases
        for svc in self.topo.infrastructure_services:
            if svc.inferred_type in ("database", "cache", "search_index"):
                data_tier_items.append({
                    "engine": svc.inferred_tech or svc.service_name,
                    "role": "cache" if svc.inferred_type == "cache" else "primary_database",
                    "detected_via": "docker_compose",
                    "service_name": svc.service_name,
                    "ports": svc.ports
                })

        # 2. Evaluate each component
        for comp in self.topo.components:
            self._evaluate_frameworks(comp)

            # Check framework assignments
            for fw in comp.detected_frameworks:
                if fw.category in ("frontend_meta", "frontend_spa"):
                    presentation_candidates.append((comp, fw))
                elif fw.category in ("backend_api", "fullstack_framework"):
                    application_candidates.append((comp, fw))
                elif fw.category == "orm":
                    # Correlate with data tier
                    data_tier_items.append({
                        "engine": self._infer_db_from_orm(fw.name, comp),
                        "role": "orm_managed_database",
                        "detected_via": "orm_manifest",
                        "associated_orm": fw.name,
                        "component_id": comp.id
                    })

        # 3. Disambiguate Presentation Tier
        if presentation_candidates:
            # Sort by confidence and meta-framework priority
            presentation_candidates.sort(key=lambda x: (
                1 if x[1].category == "frontend_meta" else 0,
                x[1].confidence_score
            ), reverse=True)
            top_comp, top_fw = presentation_candidates[0]
            
            # Find associated UI library if it's a meta-framework
            ui_lib = None
            for fw in top_comp.detected_frameworks:
                if fw.category == "ui_library":
                    ui_lib = fw.name

            three_tier.presentation_tier = {
                "component_id": top_comp.id,
                "framework": top_fw.name,
                "framework_type": "meta_framework_ssr" if top_fw.category == "frontend_meta" else "single_page_app",
                "ui_library": ui_lib,
                "confidence_score": top_fw.confidence_score,
                "path": top_comp.relative_path,
                "language": top_comp.primary_language
            }

        # 4. Disambiguate Application Tier
        for comp, fw in application_candidates:
            # Locate ORM if any
            orm_name = None
            for f in comp.detected_frameworks:
                if f.category == "orm":
                    orm_name = f.name

            three_tier.application_tier.append({
                "component_id": comp.id,
                "framework": fw.name,
                "framework_type": "fullstack_monolith" if fw.category == "fullstack_framework" else "rest_api",
                "runtime": comp.primary_language.lower(),
                "confidence_score": fw.confidence_score,
                "entrypoint": next((e for e in fw.evidence_details if "entrypoint:" in e), None),
                "orm": orm_name,
                "path": comp.relative_path
            })

        # Deduplicate data tier items
        seen_dbs = set()
        deduped_data = []
        for d in data_tier_items:
            key = (d["engine"], d["role"])
            if key not in seen_dbs:
                seen_dbs.add(key)
                deduped_data.append(d)
        three_tier.data_tier = deduped_data

        # 5. Build final deterministic JSON document
        return {
            "version": "1.0.0",
            "repository": {
                "structure": self.topo.structure_type,
                "monorepo_orchestrator": self.topo.monorepo_orchestrator,
                "total_components_detected": len(self.topo.components)
            },
            "three_tier_architecture": {
                "presentation_tier": three_tier.presentation_tier,
                "application_tier": three_tier.application_tier,
                "data_tier": three_tier.data_tier
            },
            "components": [
                {
                    "id": c.id,
                    "path": c.relative_path,
                    "role_candidate": c.role_candidate,
                    "primary_language": c.primary_language,
                    "frameworks": [
                        {
                            "name": f.name,
                            "category": f.category,
                            "confidence": f.confidence_score,
                            "evidence": f.evidence_details
                        } for f in c.detected_frameworks
                    ]
                } for c in self.topo.components
            ],
            "infrastructure": {
                "services": [
                    {
                        "name": s.service_name,
                        "image": s.image,
                        "ports": s.ports,
                        "inferred_tech": s.inferred_tech
                    } for s in self.topo.infrastructure_services
                ]
            },
            "audit": {
                "dead_dependencies_flagged": self.topo.dead_dependencies,
                "warnings": self.topo.audit_warnings
            }
        }

    def _evaluate_frameworks(self, comp: ComponentInfo):
        deps = comp.dependencies
        
        # Meta-frameworks vs SPA
        has_next = "next" in deps
        has_nuxt = "nuxt" in deps
        has_react = "react" in deps
        has_vue = "vue" in deps

        # Check anchors & AST
        # Next.js
        if has_next:
            comp.detected_frameworks.append(FrameworkEvidence(
                name="Next.js",
                category="frontend_meta",
                manifest_confirmed=True,
                confidence_score=100,
                evidence_details=["Manifest: package.json has 'next'"]
            ))
            if has_react:
                comp.detected_frameworks.append(FrameworkEvidence(
                    name="React",
                    category="ui_library",
                    manifest_confirmed=True,
                    confidence_score=100,
                    evidence_details=["Manifest: package.json has 'react' (subordinated to Next.js)"]
                ))
        elif has_react:
            comp.detected_frameworks.append(FrameworkEvidence(
                name="React",
                category="frontend_spa",
                manifest_confirmed=True,
                confidence_score=90,
                evidence_details=["Manifest: package.json has 'react'"]
            ))

        if has_nuxt:
            comp.detected_frameworks.append(FrameworkEvidence(
                name="Nuxt",
                category="frontend_meta",
                manifest_confirmed=True,
                confidence_score=100,
                evidence_details=["Manifest: package.json has 'nuxt'"]
            ))
        elif has_vue:
            comp.detected_frameworks.append(FrameworkEvidence(
                name="Vue",
                category="frontend_spa",
                manifest_confirmed=True,
                confidence_score=90,
                evidence_details=["Manifest: package.json has 'vue'"]
            ))

        # Node Backend Frameworks
        if "express" in deps:
            comp.detected_frameworks.append(FrameworkEvidence(
                name="Express",
                category="backend_api",
                manifest_confirmed=True,
                confidence_score=95,
                evidence_details=["Manifest: package.json has 'express'"]
            ))
        if "@nestjs/core" in deps:
            comp.detected_frameworks.append(FrameworkEvidence(
                name="NestJS",
                category="backend_api",
                manifest_confirmed=True,
                confidence_score=100,
                evidence_details=["Manifest: package.json has '@nestjs/core'"]
            ))
        if "fastify" in deps:
            comp.detected_frameworks.append(FrameworkEvidence(
                name="Fastify",
                category="backend_api",
                manifest_confirmed=True,
                confidence_score=95,
                evidence_details=["Manifest: package.json has 'fastify'"]
            ))

        # Python Backend Frameworks
        if "fastapi" in deps:
            comp.detected_frameworks.append(FrameworkEvidence(
                name="FastAPI",
                category="backend_api",
                manifest_confirmed=True,
                confidence_score=100,
                evidence_details=["Manifest: declared 'fastapi'"]
            ))
        if "django" in deps:
            comp.detected_frameworks.append(FrameworkEvidence(
                name="Django",
                category="fullstack_framework",
                manifest_confirmed=True,
                confidence_score=100,
                evidence_details=["Manifest: declared 'django'"]
            ))
        if "flask" in deps:
            # Check if fastapi is also present (dead dependency check)
            if "fastapi" in deps:
                self.topo.dead_dependencies.append(f"Component '{comp.id}': Flask declared alongside FastAPI (possible unused/dead dependency)")
            else:
                comp.detected_frameworks.append(FrameworkEvidence(
                    name="Flask",
                    category="backend_api",
                    manifest_confirmed=True,
                    confidence_score=90,
                    evidence_details=["Manifest: declared 'flask'"]
                ))

        # ORMs
        if "@prisma/client" in deps or "prisma" in deps:
            comp.detected_frameworks.append(FrameworkEvidence(
                name="Prisma",
                category="orm",
                manifest_confirmed=True,
                confidence_score=100,
                evidence_details=["Manifest: declared Prisma"]
            ))
        if "sqlalchemy" in deps:
            comp.detected_frameworks.append(FrameworkEvidence(
                name="SQLAlchemy",
                category="orm",
                manifest_confirmed=True,
                confidence_score=95,
                evidence_details=["Manifest: declared SQLAlchemy"]
            ))

    def _infer_db_from_orm(self, orm_name: str, comp: ComponentInfo) -> str:
        # Check drivers
        deps = comp.dependencies
        if "asyncpg" in deps or "psycopg2" in deps or "psycopg" in deps or "pg" in deps:
            return "PostgreSQL"
        if "pymysql" in deps or "mysql2" in deps or "aiomysql" in deps:
            return "MySQL"
        if "aiosqlite" in deps or "better-sqlite3" in deps:
            return "SQLite"
        if "pymongo" in deps or "motor" in deps or "mongoose" in deps:
            return "MongoDB"
        return "Relational Database (SQL)"
