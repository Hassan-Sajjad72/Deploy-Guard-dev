import {
  V1InfrastructureManifestSnapshot,
  V1ReleaseManifestSnapshot,
} from "./v1-fenced-invocation.types";
import {
  V1HandlerSideEffectBoundary,
  V1HandlerSideEffectExecutorContext,
  V1HandlerSideEffectResult,
} from "./v1-handler-side-effect.types";

export type V1EcsAppliedInfrastructureRevision =
  V1InfrastructureManifestSnapshot & {
    status: "applied";
    terraformOutputs: Record<string, unknown>;
    terraformOutputsHash: string;
  };

export type V1EcsReleaseRevision = V1ReleaseManifestSnapshot & {
  imageUri: string | null;
  imageDigest: string | null;
  taskDefinitionInputHash: string | null;
  taskDefinitionArn: string | null;
};

export type V1EcsReleaseRevisionIdentity = {
  projectId: string;
  environmentName: string;
  releaseManifestId: string;
  releaseRevision: string;
  infrastructureManifestId: string;
  infrastructureRevision: string;
};

export type V1EcsReleaseMutationIdentity = {
  idempotencyKey: string;
  registerTaskDefinitionOperationId: string;
  updateServiceOperationId: string;
};

export type V1EcsReleaseMutationExecution = {
  readonly signal: AbortSignal;
  isLeaseTrusted(): boolean;
};

export type V1EcsReleaseMutationInput = {
  revision: V1EcsReleaseRevisionIdentity;
  mutation: V1EcsReleaseMutationIdentity;
  fence: {
    intentId: string;
    leaseId: string;
    workerId: string;
    fencingToken: string;
  };
  timeoutMs: number;
  execution: V1EcsReleaseMutationExecution;
  sideEffects: V1HandlerSideEffectBoundary;
};

export type V1EcsEnvironmentReference = {
  name: string;
  source: "configuration_snapshot" | "secret_reference";
  configurationSnapshotId: string;
};

export type V1EcsServiceBindingReference = {
  id: string;
  revision: string;
};

export type V1EcsReleaseEvidenceTags = {
  projectId: string;
  environmentName: string;
  releaseManifestId: string;
  releaseRevision: string;
  infrastructureManifestId: string;
  infrastructureRevision: string;
  taskDefinitionInputHash: string;
  imageDigest: string;
};

export type V1EcsRegisterTaskDefinitionRevisionRequest = {
  region: string;
  sourceTaskDefinitionArn: string;
  family: string;
  containerName: string;
  immutableImage: string;
  command: string | null;
  containerPort: number;
  cpu: number;
  memory: number;
  logGroupName: string;
  environmentReferences: V1EcsEnvironmentReference[];
  serviceBindingReferences: V1EcsServiceBindingReference[];
  evidenceTags: V1EcsReleaseEvidenceTags;
};

export type V1EcsUpdateExistingServiceRequest = {
  region: string;
  clusterArn: string;
  serviceArn: string;
  taskDefinitionArn: string;
  forceNewDeployment: true;
};

export interface V1EcsReleaseMutationClient {
  readonly policy: "deployguard.ecs-release-mutation/client-v1";
  registerTaskDefinitionRevision(
    request: V1EcsRegisterTaskDefinitionRevisionRequest,
    ownership: V1HandlerSideEffectExecutorContext,
  ): Promise<{ taskDefinitionArn: string }>;
  updateExistingService(
    request: V1EcsUpdateExistingServiceRequest,
    ownership: V1HandlerSideEffectExecutorContext,
  ): Promise<{ serviceArn: string }>;
}

export type V1EcsReleaseManifestPair = {
  release: V1EcsReleaseRevision;
  infrastructure: V1EcsAppliedInfrastructureRevision;
  stableRuntime?: {
    serviceArn: string;
    taskDefinitionArn: string;
    serviceName: string;
    containerName: string;
  };
};

export interface V1EcsReleaseManifestStore {
  loadExact(
    identity: V1EcsReleaseRevisionIdentity,
  ): Promise<V1EcsReleaseManifestPair | null>;
  recordTaskDefinitionReference(input: {
    identity: V1EcsReleaseRevisionIdentity;
    taskDefinitionInputHash: string;
    taskDefinitionArn: string;
    fence: {
      intentId: string;
      leaseId: string;
      workerId: string;
      fencingToken: string;
    };
  }): Promise<{
    taskDefinitionInputHash: string;
    taskDefinitionArn: string;
  }>;
}

export type V1EcsReleaseMutationPlan = {
  releaseManifestId: string;
  releaseRevision: string;
  infrastructureManifestId: string;
  infrastructureRevision: string;
  taskDefinitionInputHash: string;
  serviceUpdateInputHash: string;
  registerTaskDefinition: V1EcsRegisterTaskDefinitionRevisionRequest;
  updateService: Omit<
    V1EcsUpdateExistingServiceRequest,
    "taskDefinitionArn"
  >;
};

export type V1EcsReleaseMutationResult = {
  disposition: "service_update_recorded";
  releaseManifestId: string;
  releaseRevision: string;
  infrastructureManifestId: string;
  infrastructureRevision: string;
  taskDefinitionArn: string;
  serviceArn: string;
  registerTaskDefinitionEffect: V1HandlerSideEffectResult;
  updateServiceEffect: V1HandlerSideEffectResult;
};

export class V1EcsReleaseMutationError extends Error {
  constructor(
    readonly code:
      | "ECS_RELEASE_CONTRACT_INVALID"
      | "ECS_RELEASE_MANIFEST_NOT_FOUND"
      | "ECS_RELEASE_INFRASTRUCTURE_NOT_APPLIED"
      | "ECS_RELEASE_INFRASTRUCTURE_IDENTITY_INVALID"
      | "ECS_RELEASE_IMAGE_DIGEST_REQUIRED"
      | "ECS_RELEASE_TASK_REFERENCE_CONFLICT"
      | "ECS_RELEASE_MUTATION_BLOCKED"
      | "ECS_RELEASE_OWNERSHIP_LOST"
      | "ECS_RELEASE_CLIENT_RESULT_INVALID",
  ) {
    super(code);
    this.name = "V1EcsReleaseMutationError";
  }
}
