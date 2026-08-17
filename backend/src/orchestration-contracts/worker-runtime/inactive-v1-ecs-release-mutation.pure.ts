import { canonicalSha256 } from "../contracts/canonical-json";
import {
  validateInfrastructureManifestCreate,
  validateReleaseManifestCreate,
} from "../contracts/manifest.validator";
import {
  V1EcsAppliedInfrastructureRevision,
  V1EcsReleaseManifestPair,
  V1EcsReleaseMutationError,
  V1EcsReleaseMutationIdentity,
  V1EcsReleaseMutationPlan,
  V1EcsReleaseRevision,
  V1EcsReleaseRevisionIdentity,
} from "./inactive-v1-ecs-release-mutation.types";
import { assertV1HandlerSideEffectTimeout } from "./v1-handler-side-effect.pure";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const REVISION = /^[1-9][0-9]*$/;
const ENVIRONMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const ECR_IMAGE =
  /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[0-9a-f]{64})?$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,254}$/;

function invalid(code: V1EcsReleaseMutationError["code"] =
  "ECS_RELEASE_CONTRACT_INVALID"): never {
  throw new V1EcsReleaseMutationError(code);
}

function stringOutput(
  outputs: Record<string, unknown>,
  key: string,
  pattern: RegExp = SAFE_NAME,
) {
  const value = outputs[key];
  if (typeof value !== "string" || !pattern.test(value)) {
    invalid("ECS_RELEASE_INFRASTRUCTURE_IDENTITY_INVALID");
  }
  return value;
}

function runtimeOutput(
  pair: V1EcsReleaseManifestPair,
  key: "ecs_service_arn" | "ecs_task_definition_arn" | "ecs_container_name" | "ecs_service_name",
  stableKey: "serviceArn" | "taskDefinitionArn" | "containerName" | "serviceName",
  pattern: RegExp,
) {
  const output = pair.infrastructure.terraformOutputs[key];
  const stable = pair.stableRuntime?.[stableKey];
  if (output !== undefined && (typeof output !== "string" || !pattern.test(output))) {
    invalid("ECS_RELEASE_INFRASTRUCTURE_IDENTITY_INVALID");
  }
  if (stable !== undefined && (typeof stable !== "string" || !pattern.test(stable))) {
    invalid("ECS_RELEASE_INFRASTRUCTURE_IDENTITY_INVALID");
  }
  if (typeof output === "string" && typeof stable === "string" && output !== stable) {
    invalid("ECS_RELEASE_INFRASTRUCTURE_IDENTITY_INVALID");
  }
  const resolved = typeof output === "string" ? output : stable;
  if (!resolved) invalid("ECS_RELEASE_INFRASTRUCTURE_IDENTITY_INVALID");
  return resolved;
}

function ecsArn(
  resource: "cluster" | "service" | "task-definition",
  region: string,
) {
  const escapedRegion = region.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^arn:(?:aws|aws-us-gov|aws-cn):ecs:${escapedRegion}:[0-9]{12}:`
      + `${resource}\\/[A-Za-z0-9_.\\/-]+${resource === "task-definition" ? ":[1-9][0-9]*" : ""}$`,
  );
}

function immutableImageReference(imageUri: string, imageDigest: string) {
  if (!ECR_IMAGE.test(imageUri) || !IMAGE_DIGEST.test(imageDigest)) {
    invalid("ECS_RELEASE_IMAGE_DIGEST_REQUIRED");
  }
  const withoutDigest = imageUri.split("@", 1)[0];
  const finalSlash = withoutDigest.lastIndexOf("/");
  const finalColon = withoutDigest.lastIndexOf(":");
  const repository = finalColon > finalSlash
    ? withoutDigest.slice(0, finalColon)
    : withoutDigest;
  return `${repository}@${imageDigest}`;
}

function manifestCreateInputs(pair: V1EcsReleaseManifestPair) {
  const infrastructure = pair.infrastructure;
  const release = pair.release;
  validateInfrastructureManifestCreate({
    schemaVersion: infrastructure.schemaVersion,
    projectId: infrastructure.projectId,
    environmentName: infrastructure.environmentName,
    parentManifestId: infrastructure.parentManifestId,
    createdByUserId: infrastructure.createdByUserId,
    origin: infrastructure.origin,
    terraformTemplateVersion: infrastructure.terraformTemplateVersion,
    stateBackend: infrastructure.stateBackend,
    stateKey: infrastructure.stateKey,
    desiredSpec: infrastructure.desiredSpec,
    changeSet: infrastructure.changeSet,
    requiresTerraform: infrastructure.requiresTerraform,
    specHash: infrastructure.specHash,
  });
  validateReleaseManifestCreate({
    schemaVersion: release.schemaVersion,
    projectId: release.projectId,
    environmentName: release.environmentName,
    infrastructureManifestId: release.infrastructureManifestId,
    parentManifestId: release.parentManifestId,
    previousStableManifestId: release.previousStableManifestId,
    deploymentContractId: release.deploymentContractId,
    configurationSnapshotId: release.configurationSnapshotId,
    origin: release.origin,
    repositoryFullName: release.repositoryFullName,
    branch: release.branch,
    commitSha: release.commitSha,
    appRoot: release.appRoot,
    deploymentContractHash: release.deploymentContractHash,
    configurationFingerprint: release.configurationFingerprint,
    buildFingerprint: release.buildFingerprint,
    runtimeFingerprint: release.runtimeFingerprint,
    releaseSpec: release.releaseSpec,
    specHash: release.specHash,
  });
}

function assertExactRevisions(
  identity: V1EcsReleaseRevisionIdentity,
  pair: V1EcsReleaseManifestPair,
) {
  const { release, infrastructure } = pair;
  if (
    release.id !== identity.releaseManifestId
    || release.revision !== identity.releaseRevision
    || infrastructure.id !== identity.infrastructureManifestId
    || infrastructure.revision !== identity.infrastructureRevision
    || release.projectId !== identity.projectId
    || infrastructure.projectId !== identity.projectId
    || release.environmentName !== identity.environmentName
    || infrastructure.environmentName !== identity.environmentName
    || release.infrastructureManifestId !== infrastructure.id
  ) {
    invalid();
  }
}

function environmentReferences(release: V1EcsReleaseRevision) {
  const runtime = release.releaseSpec.runtime;
  const plain = [...runtime.plainVariableNames].sort();
  const secret = [...runtime.secretReferenceNames].sort();
  if (
    new Set(plain).size !== plain.length
    || new Set(secret).size !== secret.length
    || plain.some((name) => !ENVIRONMENT_NAME.test(name))
    || secret.some((name) => !ENVIRONMENT_NAME.test(name))
    || plain.some((name) => secret.includes(name))
  ) {
    invalid();
  }
  if (
    (plain.length > 0 || secret.length > 0)
    && (!release.configurationSnapshotId
      || !UUID.test(release.configurationSnapshotId))
  ) {
    invalid();
  }
  const configurationSnapshotId = release.configurationSnapshotId ?? "";
  return [
    ...plain.map((name) => ({
      name,
      source: "configuration_snapshot" as const,
      configurationSnapshotId,
    })),
    ...secret.map((name) => ({
      name,
      source: "secret_reference" as const,
      configurationSnapshotId,
    })),
  ];
}

function validateImageMetadata(release: V1EcsReleaseRevision) {
  if (!release.imageUri || !release.imageDigest) {
    invalid("ECS_RELEASE_IMAGE_DIGEST_REQUIRED");
  }
  const runtime = release.releaseSpec.runtime;
  if (
    (runtime.imageUri !== null && runtime.imageUri !== release.imageUri)
    || (
      runtime.imageDigest !== null
      && runtime.imageDigest !== release.imageDigest
    )
  ) {
    invalid("ECS_RELEASE_IMAGE_DIGEST_REQUIRED");
  }
  return immutableImageReference(release.imageUri, release.imageDigest);
}

function validateInfrastructure(
  release: V1EcsReleaseRevision,
  infrastructure: V1EcsAppliedInfrastructureRevision,
) {
  if (infrastructure.status !== "applied") {
    invalid("ECS_RELEASE_INFRASTRUCTURE_NOT_APPLIED");
  }
  if (!HASH.test(infrastructure.terraformOutputsHash)) {
    invalid("ECS_RELEASE_INFRASTRUCTURE_IDENTITY_INVALID");
  }
  if (
    canonicalSha256(infrastructure.terraformOutputs)
      !== infrastructure.terraformOutputsHash
  ) {
    invalid("ECS_RELEASE_INFRASTRUCTURE_IDENTITY_INVALID");
  }
  if (
    release.releaseSpec.runtime.containerPort
      !== infrastructure.desiredSpec.ingress.containerPort
    || release.releaseSpec.health.expectedPort
      !== infrastructure.desiredSpec.ingress.targetGroupPort
  ) {
    invalid("ECS_RELEASE_INFRASTRUCTURE_IDENTITY_INVALID");
  }
}

export function assertV1EcsReleaseMutationIdentity(
  revision: V1EcsReleaseRevisionIdentity,
  mutation: V1EcsReleaseMutationIdentity,
  timeoutMs: number,
) {
  if (
    !UUID.test(revision.projectId)
    || !ENVIRONMENT.test(revision.environmentName)
    || !UUID.test(revision.releaseManifestId)
    || !UUID.test(revision.infrastructureManifestId)
    || !REVISION.test(revision.releaseRevision)
    || !REVISION.test(revision.infrastructureRevision)
    || !HASH.test(mutation.idempotencyKey)
    || !UUID.test(mutation.registerTaskDefinitionOperationId)
    || !UUID.test(mutation.updateServiceOperationId)
    || mutation.registerTaskDefinitionOperationId
      === mutation.updateServiceOperationId
  ) {
    invalid();
  }
  assertV1HandlerSideEffectTimeout(timeoutMs);
  return Object.freeze({
    revision: { ...revision },
    mutation: { ...mutation },
    timeoutMs,
  });
}

export function deriveV1EcsReleaseEffectIdempotencyKey(
  rootKey: string,
  effect: "register_task_definition" | "update_service",
) {
  if (!HASH.test(rootKey)) invalid();
  return canonicalSha256({
    schemaVersion: 1,
    rootKey,
    effect,
  });
}

export function buildV1EcsReleaseMutationPlan(
  identity: V1EcsReleaseRevisionIdentity,
  pair: V1EcsReleaseManifestPair,
): V1EcsReleaseMutationPlan {
  manifestCreateInputs(pair);
  assertExactRevisions(identity, pair);
  validateInfrastructure(pair.release, pair.infrastructure);

  const release = pair.release;
  const infrastructure = pair.infrastructure;
  const outputs = infrastructure.terraformOutputs;
  const region = infrastructure.desiredSpec.region;
  const clusterArn = stringOutput(
    outputs,
    "ecs_cluster_arn",
    ecsArn("cluster", region),
  );
  const serviceArn = runtimeOutput(
    pair,
    "ecs_service_arn",
    "serviceArn",
    ecsArn("service", region),
  );
  const sourceTaskDefinitionArn = runtimeOutput(
    pair,
    "ecs_task_definition_arn",
    "taskDefinitionArn",
    ecsArn("task-definition", region),
  );
  const containerName = runtimeOutput(
    pair,
    "ecs_container_name",
    "containerName",
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/,
  );
  const logGroupName = stringOutput(
    outputs,
    "ecs_log_group_name",
    /^\/[A-Za-z0-9_./#-]{1,511}$/,
  );
  const serviceName = runtimeOutput(
    pair,
    "ecs_service_name",
    "serviceName",
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/,
  );
  if (serviceName !== infrastructure.desiredSpec.ecsFoundation.serviceName) {
    invalid("ECS_RELEASE_INFRASTRUCTURE_IDENTITY_INVALID");
  }
  const immutableImage = validateImageMetadata(release);
  if (
    !immutableImage.includes(
      `.dkr.ecr.${infrastructure.desiredSpec.region}.amazonaws.com`,
    )
    && !immutableImage.includes(
      `.dkr.ecr.${infrastructure.desiredSpec.region}.amazonaws.com.cn`,
    )
  ) {
    invalid("ECS_RELEASE_IMAGE_DIGEST_REQUIRED");
  }
  const environment = environmentReferences(release);
  const registerTaskDefinitionBase = {
    region,
    sourceTaskDefinitionArn,
    family: sourceTaskDefinitionArn.split("/").at(-1)!.split(":")[0],
    containerName,
    immutableImage,
    command: release.releaseSpec.runtime.command,
    containerPort: release.releaseSpec.runtime.containerPort,
    cpu: release.releaseSpec.runtime.cpu,
    memory: release.releaseSpec.runtime.memory,
    logGroupName,
    environmentReferences: environment,
    serviceBindingReferences:
      [...release.releaseSpec.runtime.serviceBindingRevisions]
        .sort((left, right) =>
          `${left.id}:${left.revision}`.localeCompare(
            `${right.id}:${right.revision}`,
          )
        ),
  };
  const taskDefinitionInputHash = canonicalSha256({
    schemaVersion: 1,
    releaseManifestId: release.id,
    releaseRevision: release.revision,
    releaseSpecHash: release.specHash,
    infrastructureManifestId: infrastructure.id,
    infrastructureRevision: infrastructure.revision,
    infrastructureOutputsHash: infrastructure.terraformOutputsHash,
    registerTaskDefinition: registerTaskDefinitionBase,
  });
  const registerTaskDefinition = {
    ...registerTaskDefinitionBase,
    evidenceTags: {
      projectId: release.projectId,
      environmentName: release.environmentName,
      releaseManifestId: release.id,
      releaseRevision: release.revision,
      infrastructureManifestId: infrastructure.id,
      infrastructureRevision: infrastructure.revision,
      taskDefinitionInputHash,
      imageDigest: release.imageDigest!,
    },
  };
  const updateService = {
    region,
    clusterArn,
    serviceArn,
    forceNewDeployment: true as const,
  };
  return Object.freeze({
    releaseManifestId: release.id,
    releaseRevision: release.revision,
    infrastructureManifestId: infrastructure.id,
    infrastructureRevision: infrastructure.revision,
    taskDefinitionInputHash,
    serviceUpdateInputHash: canonicalSha256({
      schemaVersion: 1,
      taskDefinitionInputHash,
      updateService,
    }),
    registerTaskDefinition: Object.freeze(registerTaskDefinition),
    updateService: Object.freeze(updateService),
  });
}
