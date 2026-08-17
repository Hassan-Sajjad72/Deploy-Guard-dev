import { canonicalSha256 } from "./canonical-json";
import { DeployGuardWorkerEnvelopeV1, WORKER_MESSAGE_TYPES } from "./worker-envelope.types";
import { WORKER_PROTOCOL_NAME, WORKER_PROTOCOL_VERSION } from "./version";
import { assertNoSecretMaterial } from "./manifest.validator";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

function requireRecord(value: unknown, path: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object.`);
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, keys: string[], path: string) {
  const actual = Object.keys(record);
  const extras = actual.filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in record));
  if (extras.length || missing.length) throw new Error(`${path} has an invalid shape.`);
}

function requireString(value: unknown, path: string, pattern?: RegExp) {
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value))) throw new Error(`${path} is invalid.`);
}

function requireUuidOrNull(value: unknown, path: string) {
  if (value !== null) requireString(value, path, UUID);
}

export function workerEnvelopePayloadForHash(envelope: DeployGuardWorkerEnvelopeV1) {
  return {
    protocol: envelope.protocol,
    producer: envelope.producer,
    identity: envelope.identity,
    ...(envelope.authorization ? { authorization: envelope.authorization } : {}),
    ...(envelope.expectations ? { expectations: envelope.expectations } : {}),
    routing: envelope.routing,
    idempotency: {
      canonicalKey: envelope.idempotency.canonicalKey,
      attempt: envelope.idempotency.attempt,
      replayOfJobId: envelope.idempotency.replayOfJobId,
    },
    execution: envelope.execution,
    trace: envelope.trace,
    expiresAt: envelope.expiresAt,
  };
}

export function workerEnvelopeJobId(envelope: DeployGuardWorkerEnvelopeV1) {
  return `dg:v1:${envelope.routing.lane}:${envelope.identity.intentId}:${envelope.routing.operation}:${envelope.idempotency.attempt}`;
}

export function validateWorkerEnvelopeV1(value: unknown, now = new Date()): DeployGuardWorkerEnvelopeV1 {
  const envelope = requireRecord(value, "envelope");
  const sharedIdentity = Boolean(
    envelope.identity && typeof envelope.identity === "object"
    && !Array.isArray(envelope.identity)
    && "workspaceId" in envelope.identity,
  );
  requireExactKeys(envelope, sharedIdentity
    ? ["protocol", "producer", "identity", "authorization", "expectations", "routing", "idempotency", "execution", "trace", "expiresAt"]
    : ["protocol", "producer", "identity", "routing", "idempotency", "execution", "trace", "expiresAt"], "envelope");
  const protocol = requireRecord(envelope.protocol, "envelope.protocol");
  requireExactKeys(protocol, ["name", "schemaVersion", "messageType", "minimumWorkerProtocol", "maximumWorkerProtocol"], "envelope.protocol");
  if (protocol.name !== WORKER_PROTOCOL_NAME || protocol.schemaVersion !== WORKER_PROTOCOL_VERSION || protocol.minimumWorkerProtocol !== 1 || protocol.maximumWorkerProtocol !== 1) {
    throw new Error("Unsupported worker protocol.");
  }
  if (!WORKER_MESSAGE_TYPES.includes(protocol.messageType as never)) throw new Error("Unsupported worker message type.");

  const producer = requireRecord(envelope.producer, "envelope.producer");
  requireExactKeys(producer, ["service", "serviceVersion", "gitSha", "producedAt"], "envelope.producer");
  if (!["deployguard-api", "deployguard-outbox-dispatcher"].includes(String(producer.service))) throw new Error("Invalid worker producer.");
  requireString(producer.serviceVersion, "envelope.producer.serviceVersion");
  requireString(producer.gitSha, "envelope.producer.gitSha");
  requireString(producer.producedAt, "envelope.producer.producedAt");
  if (!Number.isFinite(new Date(String(producer.producedAt)).getTime())) throw new Error("Invalid producedAt timestamp.");

  const identity = requireRecord(envelope.identity, "envelope.identity");
  requireExactKeys(identity, sharedIdentity
    ? ["workspaceId", "intentId", "projectId", "environmentName", "pipelineRunId", "destroyOperationId", "infrastructureManifestId", "releaseManifestId"]
    : ["intentId", "projectId", "environmentName", "pipelineRunId", "destroyOperationId", "infrastructureManifestId", "releaseManifestId"], "envelope.identity");
  if (sharedIdentity) requireString(identity.workspaceId, "envelope.identity.workspaceId", /^workspace:[1-9][0-9]*$/);
  requireString(identity.intentId, "envelope.identity.intentId", UUID);
  requireString(identity.projectId, "envelope.identity.projectId", UUID);
  requireString(identity.environmentName, "envelope.identity.environmentName", /^[a-z0-9][a-z0-9_-]{0,63}$/);
  for (const key of ["pipelineRunId", "destroyOperationId", "infrastructureManifestId", "releaseManifestId"]) {
    requireUuidOrNull(identity[key], `envelope.identity.${key}`);
  }

  if (sharedIdentity) {
    const authorization = requireRecord(envelope.authorization, "envelope.authorization");
    requireExactKeys(authorization, ["actorUserId", "actorRole", "projectOwnerUserId", "policySnapshotSha256"], "envelope.authorization");
    if (!Number.isInteger(authorization.actorUserId) || Number(authorization.actorUserId) < 1
      || !Number.isInteger(authorization.projectOwnerUserId) || Number(authorization.projectOwnerUserId) < 1
      || !["admin", "developer"].includes(String(authorization.actorRole))) {
      throw new Error("Invalid worker authorization snapshot.");
    }
    requireString(authorization.policySnapshotSha256, "envelope.authorization.policySnapshotSha256", SHA256);
    const expectations = requireRecord(envelope.expectations, "envelope.expectations");
    requireExactKeys(expectations, ["sourceCommitSha", "deploymentContractHash", "infrastructureRevision", "releaseRevision", "awsAccountId", "awsRegion", "resourceNamespace"], "envelope.expectations");
    requireString(expectations.sourceCommitSha, "envelope.expectations.sourceCommitSha", /^[0-9a-f]{40,64}$/i);
    requireString(expectations.deploymentContractHash, "envelope.expectations.deploymentContractHash", SHA256);
    for (const revision of ["infrastructureRevision", "releaseRevision"] as const) {
      if (expectations[revision] !== null) requireString(expectations[revision], `envelope.expectations.${revision}`, /^[1-9][0-9]*$/);
    }
    requireString(expectations.awsAccountId, "envelope.expectations.awsAccountId", /^[0-9]{12}$/);
    requireString(expectations.awsRegion, "envelope.expectations.awsRegion", /^[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]*$/);
    requireString(expectations.resourceNamespace, "envelope.expectations.resourceNamespace", /^[a-z0-9][a-z0-9-]{2,62}$/);
  }

  const routing = requireRecord(envelope.routing, "envelope.routing");
  requireExactKeys(routing, ["lane", "operation", "queue"], "envelope.routing");
  if (!["release", "infrastructure", "deletion"].includes(String(routing.lane))) throw new Error("Invalid worker lane.");
  if (!["execute", "plan", "apply", "destroy"].includes(String(routing.operation))) throw new Error("Invalid worker operation.");
  requireString(routing.queue, "envelope.routing.queue");

  const idempotency = requireRecord(envelope.idempotency, "envelope.idempotency");
  requireExactKeys(idempotency, ["canonicalKey", "payloadSha256", "attempt", "replayOfJobId"], "envelope.idempotency");
  requireString(idempotency.canonicalKey, "envelope.idempotency.canonicalKey", SHA256);
  requireString(idempotency.payloadSha256, "envelope.idempotency.payloadSha256", SHA256);
  if (!Number.isInteger(idempotency.attempt) || Number(idempotency.attempt) < 1) throw new Error("Invalid worker attempt.");
  if (idempotency.replayOfJobId !== null) requireString(idempotency.replayOfJobId, "envelope.idempotency.replayOfJobId");

  const execution = requireRecord(envelope.execution, "envelope.execution");
  requireExactKeys(execution, ["mode", "resumeFromStage", "reusableCheckpointIds", "invalidatedCheckpointIds", "reasonCodes", "fencingTokenRequired"], "envelope.execution");
  if (!["full", "resume"].includes(String(execution.mode))) throw new Error("Invalid worker execution mode.");
  if (execution.resumeFromStage !== null) requireString(execution.resumeFromStage, "envelope.execution.resumeFromStage");
  for (const key of ["reusableCheckpointIds", "invalidatedCheckpointIds", "reasonCodes"]) {
    if (!Array.isArray(execution[key]) || !(execution[key] as unknown[]).every((item) => typeof item === "string")) throw new Error(`envelope.execution.${key} is invalid.`);
  }
  if (typeof execution.fencingTokenRequired !== "boolean") throw new Error("Invalid fencing-token requirement.");

  const trace = requireRecord(envelope.trace, "envelope.trace");
  requireExactKeys(trace, ["correlationId", "causationId", "actorUserId"], "envelope.trace");
  requireString(trace.correlationId, "envelope.trace.correlationId");
  if (trace.causationId !== null) requireString(trace.causationId, "envelope.trace.causationId");
  if (trace.actorUserId !== null && (!Number.isInteger(trace.actorUserId) || Number(trace.actorUserId) < 1)) throw new Error("Invalid actor user ID.");

  requireString(envelope.expiresAt, "envelope.expiresAt");
  const expiresAt = new Date(String(envelope.expiresAt));
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) throw new Error("Worker envelope has expired.");
  assertNoSecretMaterial(envelope, "envelope");

  const typed = envelope as unknown as DeployGuardWorkerEnvelopeV1;
  if (typed.idempotency.payloadSha256 !== canonicalSha256(workerEnvelopePayloadForHash(typed))) {
    throw new Error("Worker envelope payload hash mismatch.");
  }
  return typed;
}
