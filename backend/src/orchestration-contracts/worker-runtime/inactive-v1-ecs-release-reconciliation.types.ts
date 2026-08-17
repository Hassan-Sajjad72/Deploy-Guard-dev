import {
  V1ReadOnlySideEffectEvidenceAdapter,
} from "./v1-side-effect-reconciliation.types";
import {
  V1EcsReleaseManifestStore,
  V1EcsReleaseRevisionIdentity,
} from "./inactive-v1-ecs-release-mutation.types";

export type V1EcsReleaseReconciliationEffect =
  | "register_task_definition"
  | "update_service";

export type V1EcsTaskDefinitionEvidenceQuery = {
  region: string;
  family: string;
  containerName: string;
  projectId: string;
  environmentName: string;
  releaseManifestId: string;
  releaseRevision: string;
  infrastructureManifestId: string;
  infrastructureRevision: string;
  taskDefinitionInputHash: string;
  expectedTaskDefinitionArn: string | null;
  immutableImage: string;
  imageDigest: string;
};

export type V1EcsServiceUpdateEvidenceQuery =
  V1EcsTaskDefinitionEvidenceQuery & {
    clusterArn: string;
    serviceArn: string;
    taskDefinitionArn: string;
    serviceUpdateInputHash: string;
  };

export type V1EcsTaskDefinitionReadEvidence = {
  taskDefinitionArn: string;
  family: string;
  containerName: string;
  projectId: string;
  environmentName: string;
  releaseManifestId: string;
  releaseRevision: string;
  infrastructureManifestId: string;
  infrastructureRevision: string;
  taskDefinitionInputHash: string;
  immutableImage: string;
  imageDigest: string;
  status: "ACTIVE" | "INACTIVE";
};

export type V1EcsServiceUpdateReadEvidence = {
  clusterArn: string;
  serviceArn: string;
  family: string;
  containerName: string;
  projectId: string;
  environmentName: string;
  releaseManifestId: string;
  releaseRevision: string;
  infrastructureManifestId: string;
  infrastructureRevision: string;
  taskDefinitionInputHash: string;
  serviceUpdateInputHash: string;
  taskDefinitionArn: string;
  taskDefinitionStatus: "ACTIVE" | "INACTIVE";
  imageDigest: string;
  serviceStatus: "ACTIVE" | "DRAINING" | "INACTIVE";
  rolloutState: "COMPLETED" | "IN_PROGRESS" | "FAILED";
};

export interface V1EcsReleaseReadOnlyClient {
  readonly policy:
    | "deployguard.ecs-release-reconciliation/fixture-read-only-v1"
    | "deployguard.ecs-release-reconciliation/disabled-aws-read-only-v1";
  findTaskDefinitionEvidence(
    query: V1EcsTaskDefinitionEvidenceQuery,
    signal: AbortSignal,
  ): Promise<readonly V1EcsTaskDefinitionReadEvidence[]>;
  findServiceUpdateEvidence(
    query: V1EcsServiceUpdateEvidenceQuery,
    signal: AbortSignal,
  ): Promise<readonly V1EcsServiceUpdateReadEvidence[]>;
}

export type V1EcsReleaseFixtureReadOnlyClient =
  V1EcsReleaseReadOnlyClient & {
    readonly policy:
      "deployguard.ecs-release-reconciliation/fixture-read-only-v1";
  };

export type V1EcsReleaseReconciliationAdapterInput = {
  effect: V1EcsReleaseReconciliationEffect;
  revision: V1EcsReleaseRevisionIdentity;
  manifests: V1EcsReleaseManifestStore;
  client: V1EcsReleaseReadOnlyClient;
};

export type V1PreparedEcsReleaseReconciliationAdapter = {
  adapter: V1ReadOnlySideEffectEvidenceAdapter;
  inspectionFingerprint: string;
};

export class V1EcsReleaseReconciliationError extends Error {
  constructor(
    readonly code:
      | "ECS_RELEASE_RECONCILIATION_CONTRACT_INVALID"
      | "ECS_RELEASE_RECONCILIATION_MANIFEST_NOT_FOUND"
      | "ECS_RELEASE_RECONCILIATION_OWNERSHIP_LOST",
  ) {
    super(code);
    this.name = "V1EcsReleaseReconciliationError";
  }
}
