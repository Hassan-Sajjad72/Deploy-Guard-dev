import { TWO_LANE_CONTRACT_SCHEMA_VERSION } from "./version";

export const INFRASTRUCTURE_MANIFEST_ORIGINS = [
  "planner",
  "legacy_backfill",
  "reconciliation_import",
] as const;

export const INFRASTRUCTURE_MANIFEST_STATUSES = [
  "desired",
  "planning",
  "planned",
  "approval_required",
  "approved",
  "applying",
  "applied",
  "superseded",
  "failed",
  "destroying",
  "destroyed",
  "imported_unverified",
  "manual_review",
] as const;

export type InfrastructureManifestOrigin = typeof INFRASTRUCTURE_MANIFEST_ORIGINS[number];
export type InfrastructureManifestStatus = typeof INFRASTRUCTURE_MANIFEST_STATUSES[number];

export type InfrastructureSpecV1 = {
  region: string;
  terraformTemplateVersion: string;
  network: {
    topology: "managed_vpc";
    availabilityZoneCount: number;
    publicSubnets: boolean;
    privateSubnets: boolean;
    natMode: "none" | "single" | "per_az";
  };
  registry: {
    managedEcrRepository: boolean;
    immutableTags: boolean;
    lifecyclePolicyHash: string | null;
  };
  ecsFoundation: {
    clusterMode: "shared_project" | "dedicated_project";
    serviceName: string;
    launchType: "fargate";
    capacityProviders: string[];
  };
  ingress: {
    enabled: boolean;
    protocol: "HTTP" | "HTTPS";
    containerPort: number;
    targetGroupPort: number;
    healthCheckPath: string;
    healthCheckProtocol: "HTTP";
  };
  database: {
    mode: "none" | "managed" | "external";
    engine: "postgres" | "mysql" | null;
    tierRevision: string | null;
    persistence: boolean;
    externalTlsRequired: boolean | null;
  };
  storage: {
    efsRequired: boolean;
    accessPointRequired: boolean;
    encrypted: boolean;
    backupRequired: boolean;
  };
  discovery: {
    cloudMapRequired: boolean;
    namespace: string | null;
  };
  observability: {
    cloudWatchLogs: boolean;
    cloudWatchMetrics: boolean;
    prometheus: boolean;
  };
  iamPolicyRevision: string;
  tags: Record<string, string>;
};

export type InfrastructureChangeSetV1 = {
  fromManifestId: string | null;
  changedPaths: string[];
  categories: Array<
    | "network"
    | "registry"
    | "ecs_foundation"
    | "ingress"
    | "database"
    | "storage"
    | "discovery"
    | "observability"
    | "iam"
    | "tags"
  >;
  destructivePaths: string[];
  requiresApproval: boolean;
  reasonCodes: string[];
};

export type CreateInfrastructureManifestInputV1 = {
  schemaVersion: typeof TWO_LANE_CONTRACT_SCHEMA_VERSION;
  projectId: string;
  environmentName: string;
  parentManifestId?: string | null;
  createdByUserId?: number | null;
  origin: InfrastructureManifestOrigin;
  terraformTemplateVersion: string;
  stateBackend: "s3" | "local_mock";
  stateKey: string;
  desiredSpec: InfrastructureSpecV1;
  changeSet: InfrastructureChangeSetV1;
  requiresTerraform: boolean;
  specHash: string;
};
