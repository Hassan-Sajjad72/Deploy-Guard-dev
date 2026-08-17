import { assertNoSecretMaterial } from "../contracts/manifest.validator";
import { workerRoleForMessageType } from "../outbox/outbox-dispatcher.pure";
import {
  EXECUTABLE_V1_MESSAGE_TYPES,
  ExecutableV1MessageType,
  V1WorkerCapabilityIdentity,
} from "./inactive-v1-worker-runtime.types";

const WORKER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{2,127}$/;
const VERSION = /^[a-zA-Z0-9][a-zA-Z0-9_.+:/-]{0,127}$/;
const MINIMUM_HEARTBEAT_TTL_MS = 1_000;
const MAXIMUM_HEARTBEAT_TTL_MS = 300_000;

export function canonicalizeV1WorkerCapability(
  input: V1WorkerCapabilityIdentity,
): V1WorkerCapabilityIdentity {
  if (!WORKER_ID.test(input.workerId)) {
    throw new Error("Worker capability ID is invalid.");
  }
  if (!VERSION.test(input.serviceVersion) || !VERSION.test(input.gitSha)) {
    throw new Error("Worker capability version identity is invalid.");
  }
  if (
    !Number.isInteger(input.heartbeatTtlMs)
    || input.heartbeatTtlMs < MINIMUM_HEARTBEAT_TTL_MS
    || input.heartbeatTtlMs > MAXIMUM_HEARTBEAT_TTL_MS
  ) {
    throw new Error("Worker capability heartbeat TTL is invalid.");
  }
  if (!Array.isArray(input.supportedMessageTypes) || !input.supportedMessageTypes.length) {
    throw new Error("Worker capability must declare supported message types.");
  }
  const supportedMessageTypes = (
    [...new Set(input.supportedMessageTypes)].sort()
  ) as ExecutableV1MessageType[];
  for (const messageType of supportedMessageTypes) {
    if (!EXECUTABLE_V1_MESSAGE_TYPES.includes(messageType)) {
      throw new Error("Worker capability declares a non-executable message type.");
    }
    if (workerRoleForMessageType(messageType) !== input.role) {
      throw new Error("Worker capability role does not match its message types.");
    }
  }
  const metadata = input.metadata || {};
  assertNoSecretMaterial(metadata, "workerCapability.metadata");
  return {
    ...input,
    supportedMessageTypes,
    metadata,
  };
}
