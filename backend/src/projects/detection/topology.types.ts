import type { RepositoryEvidence } from "./repository-evidence.types";

export const TOPOLOGY_ANALYZER_VERSION = "topology-detection-v5" as const;
export const TOPOLOGY_SCHEMA_VERSION = 3 as const;

export type TopologyShape =
  | "STATIC_FRONTEND"
  | "BACKEND_API"
  | "MONOLITH_SERVES_FRONTEND"
  | "DECOUPLED_FRONTEND_BACKEND"
  | "SSR_APPLICATION"
  | "CUSTOM_SERVER_SSR"
  | "PYTHON_SERVES_FRONTEND"
  | "BOUNDED_MONOREPO"
  | "UNRESOLVED"
  | "UNSUPPORTED";

export type TopologyAnalysisState = "SUPPORTED" | "INPUT_REQUIRED" | "UNRESOLVED" | "UNSUPPORTED";
export type TopologyComponentRole = "frontend" | "backend" | "application";

export type TopologyArtifact = {
  id: string;
  root: string;
  path: string;
  kind: "static-output";
  producedBy: string;
};

export type TopologyRelationship =
  | { kind: "BUILDS_INTO"; from: string; to: string; evidence: RepositoryEvidence[] }
  | { kind: "SERVES"; from: string; to: string; evidence: RepositoryEvidence[] }
  | { kind: "USES_DATABASE"; from: string; to: string; evidence: RepositoryEvidence[] }
  | { kind: "WORKSPACE_MEMBER" | "SHARES_ROOT"; from: string; to: string; evidence: RepositoryEvidence[] }
  | {
      kind: "CALLS";
      from: string;
      to: string;
      evidence: RepositoryEvidence[];
      mode: "same-origin" | "build-time-url";
      pathPrefix: string;
      stripPathPrefix: boolean;
      buildTimeVariable: string | null;
      verificationPath: string | null;
    };

export type TopologyEnvironmentVariable = {
  name: string;
  componentId: string;
  owner: "frontend" | "backend" | "database" | "migration" | "seed" | "platform";
  phase: "build" | "runtime" | "migration" | "seed";
  exposure: "public" | "private";
  requirement: "required" | "optional" | "unknown";
  management: "user-supplied" | "DeployGuard-managed" | "repository-default";
  provenance: string[];
};

/** A deterministic build-time browser binding, not an inferred API contract. */
export type TopologyServiceBinding = {
  sourceComponent: "frontend";
  envAlias: string;
  targetComponent: "backend";
  bindingMode: "platform-proxy";
  /** The application pathname following the platform mount; null means none. */
  preservedPathname: string | null;
  platformPathPrefix: string;
};

export type TopologyComponent = {
  id: "frontend" | "backend" | "application";
  role: TopologyComponentRole;
  root: string;
  buildContext: string;
  framework: string;
  frameworkVariant: string;
  runtimeType: "static" | "server";
  port: number;
  healthCheckPath: string | null;
  healthCheckMode: "http" | "tcp";
  databaseType: "postgres" | "mysql" | "mongodb" | null;
  capabilities: string[];
  evidence: RepositoryEvidence[];
  environment: TopologyEnvironmentVariable[];
  profile: Record<string, any>;
};

export type CanonicalTopology = {
  schemaVersion: typeof TOPOLOGY_SCHEMA_VERSION;
  analyzerVersion: typeof TOPOLOGY_ANALYZER_VERSION;
  shape: TopologyShape;
  analysisState: TopologyAnalysisState;
  status: "supported" | "blocked";
  confidence: "proven" | "bounded" | "unresolved";
  evidence: RepositoryEvidence[];
  applicationUnits: Array<{
    id: string;
    root: string;
    manifests: string[];
    deployable: boolean;
    detectorIds: string[];
  }>;
  components: TopologyComponent[];
  relationships: TopologyRelationship[];
  serviceBindings: TopologyServiceBinding[];
  requiredUserInputs: string[];
  artifacts: TopologyArtifact[];
  databases: Array<{ id: string; engine: "postgres" | "mysql" | "mongodb"; ownerComponentId: string }>;
  managedDatabase: null | { engine: "postgres" | "mysql" | "mongodb"; ownerComponentId: "frontend" | "backend" | "application" };
  unresolvedEvidence: RepositoryEvidence[];
  blockers: string[];
  warnings: string[];
};

export function hasCurrentCanonicalTopology(rawProfile: unknown): boolean {
  if (!rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) return false;
  const topology = (rawProfile as Record<string, unknown>).componentTopology;
  if (!topology || typeof topology !== "object" || Array.isArray(topology)) return false;
  const candidate = topology as Record<string, unknown>;
  return candidate.schemaVersion === TOPOLOGY_SCHEMA_VERSION
    && candidate.analyzerVersion === TOPOLOGY_ANALYZER_VERSION
    && Array.isArray(candidate.components)
    && Array.isArray(candidate.relationships)
    && Array.isArray(candidate.serviceBindings)
    && Array.isArray(candidate.requiredUserInputs)
    && Array.isArray(candidate.blockers);
}
