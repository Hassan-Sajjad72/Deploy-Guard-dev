import { canonicalSha256 } from "../contracts/canonical-json";
import { assertSafeOwnershipFailureCode } from "./v1-pre-execution-ownership.pure";
import {
  V1HandlerSideEffectIdentity,
  V1HandlerSideEffectOutcome,
  V1HandlerSideEffectSafetyError,
} from "./v1-handler-side-effect.types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const EFFECT_TYPE = /^[a-z][a-z0-9_.-]{2,95}$/;
const WORKER_ID = /^[a-zA-Z0-9][a-zA-Z0-9:_.-]{2,255}$/;
const ENVIRONMENT = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) =>
    Object.prototype.hasOwnProperty.call(value, key)
  )
    && Object.keys(value).every((key) => allowed.has(key));
}

export function canonicalizeV1HandlerSideEffectIdentity(
  input: V1HandlerSideEffectIdentity,
) {
  if (
    !UUID.test(input.intentId)
    || !UUID.test(input.projectId)
    || !UUID.test(input.operationId)
    || !UUID.test(input.leaseId)
    || !ENVIRONMENT.test(input.environmentName)
    || !WORKER_ID.test(input.workerId)
    || !/^[1-9][0-9]*$/.test(input.fencingToken)
    || !HASH.test(input.idempotencyKey)
    || !HASH.test(input.inputFingerprint)
    || !EFFECT_TYPE.test(input.effectType)
  ) {
    throw new V1HandlerSideEffectSafetyError(
      "SIDE_EFFECT_CONTRACT_INVALID",
    );
  }
  return Object.freeze({ ...input });
}

export function assertV1HandlerSideEffectTimeout(timeoutMs: number) {
  if (
    !Number.isInteger(timeoutMs)
    || timeoutMs < 100
    || timeoutMs > 15 * 60_000
  ) {
    throw new V1HandlerSideEffectSafetyError(
      "SIDE_EFFECT_CONTRACT_INVALID",
    );
  }
  return timeoutMs;
}

export function v1HandlerSideEffectRequestFingerprint(
  identity: V1HandlerSideEffectIdentity,
) {
  const value = canonicalizeV1HandlerSideEffectIdentity(identity);
  return canonicalSha256({
    schemaVersion: 1,
    intentId: value.intentId,
    projectId: value.projectId,
    environmentName: value.environmentName,
    operationId: value.operationId,
    idempotencyKey: value.idempotencyKey,
    effectType: value.effectType,
    inputFingerprint: value.inputFingerprint,
  });
}

export function validateV1HandlerSideEffectOutcome(
  value: unknown,
): V1HandlerSideEffectOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new V1HandlerSideEffectSafetyError(
      "SIDE_EFFECT_CONTRACT_INVALID",
    );
  }
  const record = value as Record<string, unknown>;
  if (
    record.outcome === "succeeded"
    && exactKeys(
      record,
      ["outcome", "safeResultCode", "resultFingerprint"],
      ["externalReferenceHash"],
    )
    && typeof record.safeResultCode === "string"
    && typeof record.resultFingerprint === "string"
    && HASH.test(record.resultFingerprint)
    && (
      record.externalReferenceHash === undefined
      || record.externalReferenceHash === null
      || (
        typeof record.externalReferenceHash === "string"
        && HASH.test(record.externalReferenceHash)
      )
    )
  ) {
    assertSafeOwnershipFailureCode(record.safeResultCode);
    return value as V1HandlerSideEffectOutcome;
  }
  if (
    (record.outcome === "failed" || record.outcome === "uncertain")
    && exactKeys(record, ["outcome", "safeFailureCode"])
    && typeof record.safeFailureCode === "string"
  ) {
    assertSafeOwnershipFailureCode(record.safeFailureCode);
    return value as V1HandlerSideEffectOutcome;
  }
  throw new V1HandlerSideEffectSafetyError(
    "SIDE_EFFECT_CONTRACT_INVALID",
  );
}
