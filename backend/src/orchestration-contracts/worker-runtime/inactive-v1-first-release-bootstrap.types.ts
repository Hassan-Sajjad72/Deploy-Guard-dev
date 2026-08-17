import { CreateReleaseManifestInputV1, ReleaseSpecV1 } from "../contracts/release-manifest.types";
import { V1EcsAppliedInfrastructureRevision, V1EcsEnvironmentReference, V1EcsServiceBindingReference } from "./inactive-v1-ecs-release-mutation.types";
import { V1HandlerSideEffectBoundary, V1HandlerSideEffectExecutorContext, V1HandlerSideEffectResult } from "./v1-handler-side-effect.types";

export type V1FirstReleaseInfrastructureIdentity = {
  projectId: string;
  environmentName: string;
  infrastructureManifestId: string;
  infrastructureRevision: string;
};

export type V1FirstReleaseBootstrapIdentity = V1FirstReleaseInfrastructureIdentity & {
  intentId: string;
  idempotencyKey: string;
  buildPushOperationId: string;
  registerTaskDefinitionOperationId: string;
  createServiceOperationId: string;
};

export type V1FirstReleaseImageEvidence = {
  imageUri: string;
  imageDigest: string;
  commitSha: string;
  buildFingerprint: string;
};

export type V1FirstReleaseImageBuildRequest = {
  region: string;
  repositoryUrl: string;
  commitSha: string;
  buildFingerprint: string;
  projectId: string;
  repositoryFullName: string;
  branch: string;
  appRoot: string;
  dockerStrategy: "generated" | "custom";
  deploymentContractHash: string;
};

export type V1FirstReleaseManifest = {
  id: string;
  revision: string;
  projectId: string;
  environmentName: string;
  infrastructureManifestId: string;
  imageUri: string;
  imageDigest: string;
  releaseSpec: ReleaseSpecV1;
  taskDefinitionInputHash: string | null;
  taskDefinitionArn: string | null;
  initialServiceInputHash: string | null;
  initialServiceArn: string | null;
};

export type V1FirstReleaseTaskDefinitionRequest = {
  region: string;
  family: string;
  containerName: string;
  immutableImage: string;
  command: string | null;
  containerPort: number;
  cpu: number;
  memory: number;
  taskRoleArn: string;
  executionRoleArn: string;
  logGroupName: string;
  environmentReferences: V1EcsEnvironmentReference[];
  serviceBindingReferences: V1EcsServiceBindingReference[];
  /** Values are derived only from the applied infrastructure output contract. */
  runtimeEnvironment: ReadonlyArray<{ name: string; value: string }>;
  /** Secret Manager references only; plaintext values never enter this contract. */
  runtimeSecrets: ReadonlyArray<{ name: string; valueFrom: string }>;
  evidenceTags: Record<string, string>;
};

export type V1FirstReleaseServiceRequest = {
  region: string;
  clusterArn: string;
  serviceName: string;
  taskDefinitionArn: string;
  targetGroupArn: string;
  containerName: string;
  containerPort: number;
  subnetIds: string[];
  securityGroupIds: string[];
  assignPublicIp: boolean;
  evidenceTags: Record<string, string>;
};

export type V1FirstReleaseHealthRequest = {
  region: string;
  clusterArn: string;
  serviceArn: string;
  serviceName: string;
  taskDefinitionArn: string;
  targetGroupArn: string;
  containerPort: number;
  loadBalancerDnsName: string;
  healthPath: string;
  timeoutMs: number;
};

export type V1FirstReleaseHealthEvidence = {
  safeCode: "FIRST_RELEASE_HEALTHY";
  evidenceHash: string;
  applicationUrl: string;
};

export interface V1FirstReleaseBootstrapClient {
  readonly policy: "deployguard.first-release-bootstrap/client-v1";
  buildAndPushImmutableImage(
    input: V1FirstReleaseImageBuildRequest,
    ownership: V1HandlerSideEffectExecutorContext,
  ): Promise<V1FirstReleaseImageEvidence>;
  resolveImmutableImageEvidence(
    input: V1FirstReleaseImageBuildRequest,
    ownership: V1HandlerSideEffectExecutorContext,
  ): Promise<V1FirstReleaseImageEvidence>;
  inspectExactService(
    input: { clusterArn: string; serviceName: string; infrastructureManifestId: string; infrastructureRevision: string },
    ownership: V1HandlerSideEffectExecutorContext,
  ): Promise<{ state: "absent" | "present" | "ambiguous" }>;
  registerInitialTaskDefinition(
    input: V1FirstReleaseTaskDefinitionRequest,
    ownership: V1HandlerSideEffectExecutorContext,
  ): Promise<{ taskDefinitionArn: string }>;
  createInitialService(
    input: V1FirstReleaseServiceRequest,
    ownership: V1HandlerSideEffectExecutorContext,
  ): Promise<{ serviceArn: string }>;
  verifyInitialRelease(
    input: V1FirstReleaseHealthRequest,
    ownership: V1HandlerSideEffectExecutorContext,
  ): Promise<V1FirstReleaseHealthEvidence>;
}

export interface V1FirstReleaseBootstrapStore {
  loadAppliedInfrastructure(identity: V1FirstReleaseInfrastructureIdentity): Promise<V1EcsAppliedInfrastructureRevision | null>;
  loadImageProvenance(identity: Pick<V1FirstReleaseBootstrapIdentity, "intentId" | "buildPushOperationId">): Promise<V1FirstReleaseImageEvidence | null>;
  loadReleaseManifest(identity: Pick<V1FirstReleaseBootstrapIdentity, "intentId" | "projectId" | "environmentName" | "infrastructureManifestId">): Promise<V1FirstReleaseManifest | null>;
  recordImageProvenance(input: {
    identity: V1FirstReleaseBootstrapIdentity;
    evidence: V1FirstReleaseImageEvidence;
    evidenceFingerprint: string;
    fence: V1FirstReleaseFence;
  }): Promise<V1FirstReleaseImageEvidence>;
  createOrReuseReleaseManifest(input: {
    identity: V1FirstReleaseBootstrapIdentity;
    release: CreateReleaseManifestInputV1;
    evidence: V1FirstReleaseImageEvidence;
    fence: V1FirstReleaseFence;
  }): Promise<V1FirstReleaseManifest>;
  recordTaskDefinition(input: {
    releaseManifestId: string;
    taskDefinitionInputHash: string;
    taskDefinitionArn: string;
    fence: V1FirstReleaseFence;
  }): Promise<V1FirstReleaseManifest>;
  recordInitialService(input: {
    releaseManifestId: string;
    serviceInputHash: string;
    serviceArn: string;
    fence: V1FirstReleaseFence;
  }): Promise<V1FirstReleaseManifest>;
  recordHealthyRelease(input: {
    releaseManifestId: string;
    evidence: V1FirstReleaseHealthEvidence;
    fence: V1FirstReleaseFence;
  }): Promise<V1FirstReleaseManifest>;
}

export type V1FirstReleaseFence = {
  intentId: string;
  leaseId: string;
  workerId: string;
  fencingToken: string;
};

export type V1FirstReleaseBootstrapInput = {
  identity: V1FirstReleaseBootstrapIdentity;
  releaseDraft: CreateReleaseManifestInputV1;
  timeoutMs: number;
  execution: { signal: AbortSignal; isLeaseTrusted(): boolean };
  fence: V1FirstReleaseFence;
  sideEffects: V1HandlerSideEffectBoundary;
};

export type V1FirstReleaseBootstrapResult = {
  disposition: "initial_release_healthy";
  releaseManifestId: string;
  releaseRevision: string;
  taskDefinitionArn: string;
  serviceArn: string;
  applicationUrl: string;
  healthEvidenceHash: string;
  imageEffect: V1HandlerSideEffectResult;
  taskDefinitionEffect: V1HandlerSideEffectResult;
  serviceEffect: V1HandlerSideEffectResult;
};

export class V1FirstReleaseBootstrapError extends Error {
  constructor(readonly code: string) { super(code); }
}
