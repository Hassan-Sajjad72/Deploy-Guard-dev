"""
Main Entrypoint for Tech Stack & 3-Tier Architecture Detector
"""
import sys
import json
from pathlib import Path
from typing import Dict, Any

from .models import RepoTopology
from .boundary_resolver import BoundaryResolver
from .manifest_parser import ManifestParser
from .anchor_scanner import AnchorScanner
from .ast_verifier import ASTVerifier
from .infra_orchestration import InfraOrchestrator
from .tier_stitcher import TierStitcher

class StackDetector:
    def __init__(self, target_dir: str):
        self.target = Path(target_dir).resolve()

    def run(self) -> Dict[str, Any]:
        # Pass 0: Workspace Boundary & Repo Structure Resolver
        boundary_resolver = BoundaryResolver(str(self.target))
        struct_type, orchestrator, components = boundary_resolver.resolve()

        topology = RepoTopology(
            structure_type=struct_type,
            monorepo_orchestrator=orchestrator,
            root_path=str(self.target),
            components=components
        )

        # Pass 1: Manifest & Lockfile Parsing
        manifest_parser = ManifestParser(self.target)
        for comp in topology.components:
            manifest_parser.parse_component_manifests(comp)

        # Pass 2: Configuration & Anchor File Verification
        anchor_scanner = AnchorScanner(self.target)
        for comp in topology.components:
            anchors = anchor_scanner.scan_component(comp)
            # Annotate component with anchors
            for anchor_name, info in anchors.items():
                comp.entrypoints.append(f"Anchor:{anchor_name}")

        # Pass 3: AST Import & Invocation Verification
        ast_verifier = ASTVerifier(self.target)
        for comp in topology.components:
            ast_results = ast_verifier.verify_component(comp)
            for k, v in ast_results.items():
                if v.get("instantiated") and "entrypoint" in v:
                    comp.entrypoints.append(f"entrypoint:{v['entrypoint']}")

        # Pass 4: Infrastructure & Orchestration Grapher
        infra_orchestrator = InfraOrchestrator(self.target)
        topology.infrastructure_services = infra_orchestrator.scan()

        # Pass 5: 3-Tier Stitching & Consensus Disambiguation
        stitcher = TierStitcher(topology)
        final_result = stitcher.stitch()

        return final_result

def main():
    target = sys.argv[1] if len(sys.argv) > 1 else "."
    detector = StackDetector(target)
    result = detector.run()
    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()
