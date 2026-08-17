import { TWO_LANE_CONTRACT_SCHEMA_VERSION } from "./version";

export const RELEASE_MANIFEST_ORIGINS = ["planner", "legacy_backfill", "rollback"] as const;

export const RELEASE_MANIFEST_STATUSES = [
  "desired",
  "blocked_on_infrastructure",
  "building",
  "built",
  "deploying",
  "waiting_for_stability",
  "health_checking",
  "healthy",
  "stable",
  "failed",
  "rollback_started",
  "rolled_back",
  "superseded",
  "cancelled",
  "imported_unverified",
  "manual_review",
] as const;

export type ReleaseManifestOrigin = typeof RELEASE_MANIFEST_ORIGINS[number];
export type ReleaseManifestStatus = typeof RELEASE_MANIFEST_STATUSES[number];

export type ReleaseSpecV1 = {
  source: {
    repositoryFullName: string;
    branch: string;
    commitSha: string;
    appRoot: string;
  };
  build: {
    dockerStrategy: "generated" | "custom";
    dockerTemplate: string | null;
    buildCommand: string | null;
    outputDirectory: string | null;
    buildArgumentNames: string[];
  };
  runtime: {
    imageUri: string | null;
    imageDigest: string | null;
    command: string | null;
    containerPort: number;
    cpu: number;
    memory: number;
    plainVariableNames: string[];
    secretReferenceNames: string[];
    serviceBindingRevisions: Array<{ id: string; revision: string }>;
  };
  health: {
    path: string;
    expectedPort: number;
    gracePeriodSeconds: number;
  };
};

export type CreateReleaseManifestInputV1 = {
  schemaVersion: typeof TWO_LANE_CONTRACT_SCHEMA_VERSION;
  projectId: string;
  environmentName: string;
  infrastructureManifestId: string;
  parentManifestId?: string | null;
  previousStableManifestId?: string | null;
  deploymentContractId?: string | null;
  configurationSnapshotId?: string | null;
  origin: ReleaseManifestOrigin;
  repositoryFullName: string;
  branch: string;
  commitSha: string;
  appRoot: string;
  deploymentContractHash: string;
  configurationFingerprint: string;
  buildFingerprint: string;
  runtimeFingerprint: string;
  releaseSpec: ReleaseSpecV1;
  specHash: string;
};
