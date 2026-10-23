import { canonicalSha256 } from "../contracts/canonical-json";
import { validateReleaseManifestCreate } from "../contracts/manifest.validator";
import { V1EcsAppliedInfrastructureRevision } from "./inactive-v1-ecs-release-mutation.types";
import {
  V1FirstReleaseBootstrapError,
  V1FirstReleaseBootstrapIdentity,
  V1FirstReleaseImageEvidence,
  V1FirstReleaseManifest,
  V1FirstReleaseServiceRequest,
  V1FirstReleaseHealthRequest,
  V1FirstReleaseTaskDefinitionRequest,
} from "./inactive-v1-first-release-bootstrap.types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ECR = /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/[a-z0-9][a-z0-9._/-]*(?:@sha256:[0-9a-f]{64})?$/;
const ARN = /^arn:(?:aws|aws-us-gov|aws-cn):[a-z0-9-]+:[a-z0-9-]*:[0-9]{12}:.+$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/;
const SAFE_LOG_GROUP = /^\/[A-Za-z0-9_./#-]{1,511}$/;

function invalid(code = "FIRST_RELEASE_CONTRACT_INVALID"): never {
  throw new V1FirstReleaseBootstrapError(code);
}

function output(outputs: Record<string, unknown>, key: string, pattern: RegExp) {
  const value = outputs[key];
  if (typeof value !== "string" || !pattern.test(value)) invalid("FIRST_RELEASE_INFRASTRUCTURE_OUTPUT_INVALID");
  return value;
}

function arrayOutput(outputs: Record<string, unknown>, key: string) {
  const value = outputs[key];
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.length > 512)) {
    invalid("FIRST_RELEASE_INFRASTRUCTURE_OUTPUT_INVALID");
  }
  return [...new Set(value)].sort() as string[];
}

export function assertV1FirstReleaseIdentity(identity: V1FirstReleaseBootstrapIdentity) {
  if (!UUID.test(identity.projectId) || !UUID.test(identity.infrastructureManifestId) || !UUID.test(identity.intentId)
    || identity.environmentName !== "dev" || !/^[1-9][0-9]*$/.test(identity.infrastructureRevision)
    || !HASH.test(identity.idempotencyKey)
    || !UUID.test(identity.buildPushOperationId) || !UUID.test(identity.registerTaskDefinitionOperationId)
    || !UUID.test(identity.createServiceOperationId)) invalid();
  const ids = new Set([identity.buildPushOperationId, identity.registerTaskDefinitionOperationId, identity.createServiceOperationId]);
  if (ids.size !== 3) invalid();
}

export function immutableEcrImage(imageUri: string, imageDigest: string) {
  const base = imageUri.split("@", 1)[0];
  if (!ECR.test(base) || !DIGEST.test(imageDigest)) invalid("FIRST_RELEASE_IMAGE_PROVENANCE_INVALID");
  return `${base}@${imageDigest}`;
}

export function assertV1FirstReleaseEvidence(
  identity: V1FirstReleaseBootstrapIdentity,
  infrastructure: V1EcsAppliedInfrastructureRevision,
  evidence: V1FirstReleaseImageEvidence,
) {
  assertV1FirstReleaseIdentity(identity);
  if (infrastructure.status !== "applied" || infrastructure.id !== identity.infrastructureManifestId
    || infrastructure.projectId !== identity.projectId || infrastructure.environmentName !== identity.environmentName
    || infrastructure.revision !== identity.infrastructureRevision || !HASH.test(infrastructure.terraformOutputsHash)
    || canonicalSha256(infrastructure.terraformOutputs) !== infrastructure.terraformOutputsHash
    || !HASH.test(evidence.buildFingerprint) || !/^[0-9a-f]{40,64}$/i.test(evidence.commitSha)) {
    invalid("FIRST_RELEASE_INFRASTRUCTURE_IDENTITY_INVALID");
  }
  immutableEcrImage(evidence.imageUri, evidence.imageDigest);
  const repositoryUrl = output(infrastructure.terraformOutputs, "ecr_repository_url", /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/[a-z0-9][a-z0-9._/-]*$/);
  if (!immutableEcrImage(evidence.imageUri, evidence.imageDigest).startsWith(`${repositoryUrl}@`)) {
    invalid("FIRST_RELEASE_IMAGE_PROVENANCE_INVALID");
  }
}

export function injectV1FirstReleaseImage(draft: import("../contracts/release-manifest.types").CreateReleaseManifestInputV1, evidence: V1FirstReleaseImageEvidence) {
  if (draft.releaseSpec.runtime.imageUri !== null || draft.releaseSpec.runtime.imageDigest !== null) invalid("FIRST_RELEASE_DRAFT_MUST_NOT_CONTAIN_IMAGE");
  const releaseSpec = {
    ...draft.releaseSpec,
    runtime: { ...draft.releaseSpec.runtime, imageUri: evidence.imageUri, imageDigest: evidence.imageDigest },
  };
  const release = { ...draft, releaseSpec, specHash: canonicalSha256(releaseSpec) };
  validateReleaseManifestCreate(release);
  return release;
}

export function buildV1FirstReleaseServiceProbe(
  identity: V1FirstReleaseBootstrapIdentity,
  infrastructure: V1EcsAppliedInfrastructureRevision,
) {
  if (infrastructure.status !== "applied" || infrastructure.id !== identity.infrastructureManifestId
    || infrastructure.projectId !== identity.projectId || infrastructure.environmentName !== identity.environmentName
    || infrastructure.revision !== identity.infrastructureRevision || canonicalSha256(infrastructure.terraformOutputs) !== infrastructure.terraformOutputsHash) {
    invalid("FIRST_RELEASE_INFRASTRUCTURE_IDENTITY_INVALID");
  }
  const clusterArn = output(infrastructure.terraformOutputs, "ecs_cluster_arn", ARN);
  const serviceName = infrastructure.desiredSpec.ecsFoundation.serviceName;
  if (!SAFE_NAME.test(serviceName)) invalid("FIRST_RELEASE_INFRASTRUCTURE_OUTPUT_INVALID");
  return Object.freeze({ clusterArn, serviceName, infrastructureManifestId: identity.infrastructureManifestId, infrastructureRevision: identity.infrastructureRevision });
}

export function buildV1FirstReleaseMutationPlan(input: {
  identity: V1FirstReleaseBootstrapIdentity;
  infrastructure: V1EcsAppliedInfrastructureRevision;
  release: V1FirstReleaseManifest;
}) {
  const { identity, infrastructure, release } = input;
  const outputs = infrastructure.terraformOutputs;
  const region = infrastructure.desiredSpec.region;
  const clusterArn = output(outputs, "ecs_cluster_arn", ARN);
  const repositoryUrl = output(outputs, "ecr_repository_url", /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/[a-z0-9][a-z0-9._/-]*$/);
  const taskRoleArn = output(outputs, "ecs_task_role_arn", ARN);
  const executionRoleArn = output(outputs, "ecs_execution_role_arn", ARN);
  const logGroupName = output(outputs, "ecs_log_group_name", SAFE_LOG_GROUP);
  const targetGroupArn = output(outputs, "alb_target_group_arn", ARN);
  const loadBalancerDnsName = output(outputs, "alb_dns_name", /^[A-Za-z0-9.-]{1,253}$/);
  const securityGroupId = output(outputs, "app_security_group_id", /^sg-[a-z0-9]+$/);
  const subnetIds = arrayOutput(outputs, "public_subnet_ids");
  const serviceName = infrastructure.desiredSpec.ecsFoundation.serviceName;
  if (!SAFE_NAME.test(serviceName) || release.releaseSpec.runtime.containerPort !== infrastructure.desiredSpec.ingress.containerPort) invalid("FIRST_RELEASE_INFRASTRUCTURE_IDENTITY_INVALID");
  const containerName = "app";
  const immutableImage = immutableEcrImage(release.imageUri, release.imageDigest);
  if (!immutableImage.startsWith(`${repositoryUrl}@`)) invalid("FIRST_RELEASE_IMAGE_PROVENANCE_INVALID");
  const environmentReferences = [
    ...release.releaseSpec.runtime.plainVariableNames.map((name) => ({ name, source: "configuration_snapshot" as const, configurationSnapshotId: release.id })),
    ...release.releaseSpec.runtime.secretReferenceNames.map((name) => ({ name, source: "secret_reference" as const, configurationSnapshotId: release.id })),
  ].sort((a, b) => a.name.localeCompare(b.name));
  const evidenceTags = Object.freeze({
    "deployguard:project-id": identity.projectId,
    "deployguard:environment": identity.environmentName,
    "deployguard:infrastructure-manifest-id": identity.infrastructureManifestId,
    "deployguard:infrastructure-revision": identity.infrastructureRevision,
    "deployguard:release-manifest-id": release.id,
    "deployguard:release-revision": release.revision,
  });
  const taskBase = {
    region, family: `deployguard-${identity.projectId.slice(0, 8)}`, containerName, immutableImage,
    command: release.releaseSpec.runtime.command, containerPort: release.releaseSpec.runtime.containerPort,
    cpu: release.releaseSpec.runtime.cpu, memory: release.releaseSpec.runtime.memory, taskRoleArn,
    executionRoleArn, logGroupName, environmentReferences,
    serviceBindingReferences: [...release.releaseSpec.runtime.serviceBindingRevisions].sort((a, b) => `${a.id}:${a.revision}`.localeCompare(`${b.id}:${b.revision}`)),
  };
  const taskDefinitionInputHash = canonicalSha256({ schemaVersion: 1, releaseManifestId: release.id, releaseRevision: release.revision, infrastructureOutputsHash: infrastructure.terraformOutputsHash, task: taskBase });
  const registerTaskDefinition: V1FirstReleaseTaskDefinitionRequest = { ...taskBase, evidenceTags: { ...evidenceTags, "deployguard:task-input-hash": taskDefinitionInputHash } };
  if (outputs.canary_ecs_assign_public_ip !== true) invalid("FIRST_RELEASE_EGRESS_STRATEGY_INVALID");
  const serviceBase = { region, clusterArn, serviceName, targetGroupArn, containerName, containerPort: taskBase.containerPort, subnetIds, securityGroupIds: [securityGroupId], assignPublicIp: true };
  const serviceInputHash = canonicalSha256({ schemaVersion: 1, taskDefinitionInputHash, service: serviceBase });
  return Object.freeze({
    taskDefinitionInputHash,
    serviceInputHash,
    registerTaskDefinition,
    createService: (taskDefinitionArn: string): V1FirstReleaseServiceRequest => ({ ...serviceBase, taskDefinitionArn, evidenceTags: { ...evidenceTags, "deployguard:task-input-hash": taskDefinitionInputHash, "deployguard:service-input-hash": serviceInputHash } }),
    verifyHealth: (taskDefinitionArn: string, serviceArn: string, timeoutMs: number): V1FirstReleaseHealthRequest => ({
      region,
      clusterArn,
      serviceArn,
      serviceName,
      taskDefinitionArn,
      targetGroupArn,
      containerPort: taskBase.containerPort,
      loadBalancerDnsName,
      healthPath: release.releaseSpec.health.path,
      timeoutMs,
    }),
  });
}

export function deriveV1FirstReleaseEffectKey(root: string, effect: "push_image" | "register_task" | "create_service", operationId: string) {
  if (!HASH.test(root) || !UUID.test(operationId)) invalid();
  return canonicalSha256({ schemaVersion: 1, root, effect, operationId });
}
