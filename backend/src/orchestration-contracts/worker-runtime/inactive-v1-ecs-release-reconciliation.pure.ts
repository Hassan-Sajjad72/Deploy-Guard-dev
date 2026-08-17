import { canonicalSha256 } from "../contracts/canonical-json";
import {
  V1ReadOnlySideEffectEvidence,
} from "./v1-side-effect-reconciliation.types";
import {
  V1EcsServiceUpdateEvidenceQuery,
  V1EcsServiceUpdateReadEvidence,
  V1EcsTaskDefinitionEvidenceQuery,
  V1EcsTaskDefinitionReadEvidence,
} from "./inactive-v1-ecs-release-reconciliation.types";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const REVISION = /^[1-9][0-9]*$/;
const ENVIRONMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const IMMUTABLE_ECR_IMAGE =
  /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/;
const ECS_TASK_DEFINITION_ARN =
  /^arn:(?:aws|aws-us-gov|aws-cn):ecs:[a-z0-9-]+:[0-9]{12}:task-definition\/[A-Za-z0-9_.\/-]+:[1-9][0-9]*$/;
const ECS_CLUSTER_ARN =
  /^arn:(?:aws|aws-us-gov|aws-cn):ecs:[a-z0-9-]+:[0-9]{12}:cluster\/[A-Za-z0-9_.\/-]+$/;
const ECS_SERVICE_ARN =
  /^arn:(?:aws|aws-us-gov|aws-cn):ecs:[a-z0-9-]+:[0-9]{12}:service\/[A-Za-z0-9_.\/-]+$/;
const TASK_FAMILY = /^[A-Za-z0-9_-]{1,255}$/;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/;

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
) {
  return Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function taskQueryValid(query: V1EcsTaskDefinitionEvidenceQuery) {
  return (
    /^[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]*$/.test(query.region)
    && TASK_FAMILY.test(query.family)
    && CONTAINER_NAME.test(query.containerName)
    && UUID.test(query.projectId)
    && ENVIRONMENT.test(query.environmentName)
    && UUID.test(query.releaseManifestId)
    && REVISION.test(query.releaseRevision)
    && UUID.test(query.infrastructureManifestId)
    && REVISION.test(query.infrastructureRevision)
    && HASH.test(query.taskDefinitionInputHash)
    && (
      query.expectedTaskDefinitionArn === null
      || ECS_TASK_DEFINITION_ARN.test(query.expectedTaskDefinitionArn)
    )
    && IMMUTABLE_ECR_IMAGE.test(query.immutableImage)
    && IMAGE_DIGEST.test(query.imageDigest)
    && query.immutableImage.endsWith(`@${query.imageDigest}`)
  );
}

function taskEvidenceValid(value: unknown):
value is V1EcsTaskDefinitionReadEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return exactKeys(record, [
    "taskDefinitionArn",
    "family",
    "containerName",
    "projectId",
    "environmentName",
    "releaseManifestId",
    "releaseRevision",
    "infrastructureManifestId",
    "infrastructureRevision",
    "taskDefinitionInputHash",
    "immutableImage",
    "imageDigest",
    "status",
  ])
    && typeof record.taskDefinitionArn === "string"
    && ECS_TASK_DEFINITION_ARN.test(record.taskDefinitionArn)
    && typeof record.family === "string"
    && TASK_FAMILY.test(record.family)
    && typeof record.containerName === "string"
    && CONTAINER_NAME.test(record.containerName)
    && typeof record.projectId === "string"
    && UUID.test(record.projectId)
    && typeof record.environmentName === "string"
    && ENVIRONMENT.test(record.environmentName)
    && typeof record.releaseManifestId === "string"
    && UUID.test(record.releaseManifestId)
    && typeof record.releaseRevision === "string"
    && REVISION.test(record.releaseRevision)
    && typeof record.infrastructureManifestId === "string"
    && UUID.test(record.infrastructureManifestId)
    && typeof record.infrastructureRevision === "string"
    && REVISION.test(record.infrastructureRevision)
    && typeof record.taskDefinitionInputHash === "string"
    && HASH.test(record.taskDefinitionInputHash)
    && typeof record.immutableImage === "string"
    && IMMUTABLE_ECR_IMAGE.test(record.immutableImage)
    && typeof record.imageDigest === "string"
    && IMAGE_DIGEST.test(record.imageDigest)
    && (record.status === "ACTIVE" || record.status === "INACTIVE");
}

function serviceEvidenceValid(value: unknown):
value is V1EcsServiceUpdateReadEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return exactKeys(record, [
    "clusterArn",
    "serviceArn",
    "family",
    "containerName",
    "projectId",
    "environmentName",
    "releaseManifestId",
    "releaseRevision",
    "infrastructureManifestId",
    "infrastructureRevision",
    "taskDefinitionInputHash",
    "serviceUpdateInputHash",
    "taskDefinitionArn",
    "taskDefinitionStatus",
    "imageDigest",
    "serviceStatus",
    "rolloutState",
  ])
    && typeof record.clusterArn === "string"
    && ECS_CLUSTER_ARN.test(record.clusterArn)
    && typeof record.serviceArn === "string"
    && ECS_SERVICE_ARN.test(record.serviceArn)
    && typeof record.family === "string"
    && TASK_FAMILY.test(record.family)
    && typeof record.containerName === "string"
    && CONTAINER_NAME.test(record.containerName)
    && typeof record.projectId === "string"
    && UUID.test(record.projectId)
    && typeof record.environmentName === "string"
    && ENVIRONMENT.test(record.environmentName)
    && typeof record.releaseManifestId === "string"
    && UUID.test(record.releaseManifestId)
    && typeof record.releaseRevision === "string"
    && REVISION.test(record.releaseRevision)
    && typeof record.infrastructureManifestId === "string"
    && UUID.test(record.infrastructureManifestId)
    && typeof record.infrastructureRevision === "string"
    && REVISION.test(record.infrastructureRevision)
    && typeof record.taskDefinitionInputHash === "string"
    && HASH.test(record.taskDefinitionInputHash)
    && typeof record.serviceUpdateInputHash === "string"
    && HASH.test(record.serviceUpdateInputHash)
    && typeof record.taskDefinitionArn === "string"
    && ECS_TASK_DEFINITION_ARN.test(record.taskDefinitionArn)
    && (
      record.taskDefinitionStatus === "ACTIVE"
      || record.taskDefinitionStatus === "INACTIVE"
    )
    && typeof record.imageDigest === "string"
    && IMAGE_DIGEST.test(record.imageDigest)
    && (
      record.serviceStatus === "ACTIVE"
      || record.serviceStatus === "DRAINING"
      || record.serviceStatus === "INACTIVE"
    )
    && (
      record.rolloutState === "COMPLETED"
      || record.rolloutState === "IN_PROGRESS"
      || record.rolloutState === "FAILED"
    );
}

function taskMatches(
  query: V1EcsTaskDefinitionEvidenceQuery,
  evidence: V1EcsTaskDefinitionReadEvidence,
) {
  return evidence.projectId === query.projectId
    && evidence.family === query.family
    && evidence.containerName === query.containerName
    && evidence.environmentName === query.environmentName
    && evidence.releaseManifestId === query.releaseManifestId
    && evidence.releaseRevision === query.releaseRevision
    && evidence.infrastructureManifestId === query.infrastructureManifestId
    && evidence.infrastructureRevision === query.infrastructureRevision
    && evidence.taskDefinitionInputHash === query.taskDefinitionInputHash
    && evidence.immutableImage === query.immutableImage
    && evidence.imageDigest === query.imageDigest
    && (
      query.expectedTaskDefinitionArn === null
      || evidence.taskDefinitionArn === query.expectedTaskDefinitionArn
    );
}

function serviceMatches(
  query: V1EcsServiceUpdateEvidenceQuery,
  evidence: V1EcsServiceUpdateReadEvidence,
) {
  return evidence.clusterArn === query.clusterArn
    && evidence.serviceArn === query.serviceArn
    && evidence.family === query.family
    && evidence.containerName === query.containerName
    && evidence.projectId === query.projectId
    && evidence.environmentName === query.environmentName
    && evidence.releaseManifestId === query.releaseManifestId
    && evidence.releaseRevision === query.releaseRevision
    && evidence.infrastructureManifestId === query.infrastructureManifestId
    && evidence.infrastructureRevision === query.infrastructureRevision
    && evidence.taskDefinitionInputHash
      === query.taskDefinitionInputHash
    && evidence.serviceUpdateInputHash === query.serviceUpdateInputHash
    && evidence.taskDefinitionArn === query.taskDefinitionArn
    && evidence.imageDigest === query.imageDigest;
}

function pending(code: string, identity: unknown):
V1ReadOnlySideEffectEvidence {
  return {
    classification: "pending",
    safeEvidenceCode: code,
    evidenceFingerprint: canonicalSha256(identity),
  };
}

function manual(code: string, identity: unknown):
V1ReadOnlySideEffectEvidence {
  return {
    classification: "manual_review",
    safeFailureCode: code,
    evidenceFingerprint: canonicalSha256(identity),
  };
}

export function classifyV1EcsTaskDefinitionEvidence(
  query: V1EcsTaskDefinitionEvidenceQuery,
  evidence: unknown,
): V1ReadOnlySideEffectEvidence {
  const base = { schemaVersion: 1, kind: "task_definition", query };
  if (!taskQueryValid(query) || !Array.isArray(evidence)) {
    return manual("ECS_RECONCILIATION_EVIDENCE_INVALID", base);
  }
  if (evidence.length === 0) {
    return pending("ECS_TASK_DEFINITION_NOT_VISIBLE", base);
  }
  if (
    evidence.length !== 1
    || !taskEvidenceValid(evidence[0])
    || !taskMatches(query, evidence[0])
  ) {
    return manual("ECS_TASK_DEFINITION_EVIDENCE_AMBIGUOUS", {
      ...base,
      evidenceCount: evidence.length,
    });
  }
  const selected = evidence[0];
  const fingerprint = canonicalSha256({ ...base, selected });
  if (selected.status === "INACTIVE") {
    return {
      classification: "failed",
      safeFailureCode: "ECS_TASK_DEFINITION_INACTIVE",
      evidenceFingerprint: fingerprint,
    };
  }
  return {
    classification: "succeeded",
    safeEvidenceCode: "ECS_TASK_DEFINITION_REGISTRATION_CONFIRMED",
    evidenceFingerprint: fingerprint,
    resultFingerprint: canonicalSha256({
      schemaVersion: 1,
      taskDefinitionInputHash: query.taskDefinitionInputHash,
      taskDefinitionArn: selected.taskDefinitionArn,
    }),
    externalReferenceHash: canonicalSha256({
      taskDefinitionArn: selected.taskDefinitionArn,
    }),
  };
}

export function classifyV1EcsServiceUpdateEvidence(
  query: V1EcsServiceUpdateEvidenceQuery,
  evidence: unknown,
): V1ReadOnlySideEffectEvidence {
  const base = { schemaVersion: 1, kind: "service_update", query };
  if (
    !taskQueryValid(query)
    || !ECS_CLUSTER_ARN.test(query.clusterArn)
    || !ECS_SERVICE_ARN.test(query.serviceArn)
    || !ECS_TASK_DEFINITION_ARN.test(query.taskDefinitionArn)
    || !HASH.test(query.serviceUpdateInputHash)
    || !Array.isArray(evidence)
  ) {
    return manual("ECS_RECONCILIATION_EVIDENCE_INVALID", base);
  }
  if (evidence.length === 0) {
    return pending("ECS_SERVICE_UPDATE_NOT_VISIBLE", base);
  }
  if (
    evidence.length !== 1
    || !serviceEvidenceValid(evidence[0])
    || !serviceMatches(query, evidence[0])
  ) {
    return manual("ECS_SERVICE_UPDATE_EVIDENCE_AMBIGUOUS", {
      ...base,
      evidenceCount: evidence.length,
    });
  }
  const selected = evidence[0];
  const fingerprint = canonicalSha256({ ...base, selected });
  if (
    selected.serviceStatus === "INACTIVE"
    || selected.taskDefinitionStatus === "INACTIVE"
    || selected.rolloutState === "FAILED"
  ) {
    return {
      classification: "failed",
      safeFailureCode: "ECS_SERVICE_UPDATE_FAILED",
      evidenceFingerprint: fingerprint,
    };
  }
  if (
    selected.serviceStatus === "DRAINING"
    || selected.rolloutState === "IN_PROGRESS"
  ) {
    return {
      classification: "pending",
      safeEvidenceCode: "ECS_SERVICE_UPDATE_PENDING",
      evidenceFingerprint: fingerprint,
    };
  }
  return {
    classification: "succeeded",
    safeEvidenceCode: "ECS_SERVICE_UPDATE_CONFIRMED",
    evidenceFingerprint: fingerprint,
    resultFingerprint: canonicalSha256({
      schemaVersion: 1,
      serviceUpdateInputHash: query.serviceUpdateInputHash,
      clusterArn: query.clusterArn,
      serviceArn: query.serviceArn,
      taskDefinitionArn: query.taskDefinitionArn,
    }),
    externalReferenceHash: canonicalSha256({
      serviceArn: query.serviceArn,
    }),
  };
}
