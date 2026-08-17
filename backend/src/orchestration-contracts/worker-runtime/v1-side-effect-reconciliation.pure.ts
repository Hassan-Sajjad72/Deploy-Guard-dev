import { canonicalSha256 } from "../contracts/canonical-json";
import { assertSafeOwnershipFailureCode } from "./v1-pre-execution-ownership.pure";
import {
  V1ReadOnlySideEffectEvidence,
  V1SideEffectReconciliationError,
  V1SideEffectReconciliationIdentity,
  V1SideEffectReconciliationLogicalIdentity,
} from "./v1-side-effect-reconciliation.types";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const SAFE_SLUG = /^[a-z][a-z0-9_.-]{2,95}$/;
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
  ) && Object.keys(value).every((key) => allowed.has(key));
}

export function canonicalizeV1SideEffectReconciliationIdentity(
  input: V1SideEffectReconciliationIdentity,
) {
  canonicalizeV1SideEffectReconciliationLogicalIdentity(input);
  if (
    !UUID.test(input.leaseId)
    || !WORKER_ID.test(input.workerId)
    || !/^[1-9][0-9]*$/.test(input.fencingToken)
  ) {
    throw new V1SideEffectReconciliationError(
      "SIDE_EFFECT_RECONCILIATION_CONTRACT_INVALID",
    );
  }
  return Object.freeze({ ...input });
}

export function canonicalizeV1SideEffectReconciliationLogicalIdentity(
  input: V1SideEffectReconciliationLogicalIdentity,
) {
  if (
    !UUID.test(input.sideEffectId)
    || !UUID.test(input.intentId)
    || !UUID.test(input.projectId)
    || !UUID.test(input.operationId)
    || !HASH.test(input.idempotencyKey)
    || !HASH.test(input.inspectionFingerprint)
    || !HASH.test(input.effectRequestFingerprint)
    || !SAFE_SLUG.test(input.adapterId)
    || !ENVIRONMENT.test(input.environmentName)
  ) {
    throw new V1SideEffectReconciliationError(
      "SIDE_EFFECT_RECONCILIATION_CONTRACT_INVALID",
    );
  }
  return Object.freeze({ ...input });
}

export function assertV1SideEffectReconciliationTimeout(timeoutMs: number) {
  if (
    !Number.isInteger(timeoutMs)
    || timeoutMs < 100
    || timeoutMs > 5 * 60_000
  ) {
    throw new V1SideEffectReconciliationError(
      "SIDE_EFFECT_RECONCILIATION_CONTRACT_INVALID",
    );
  }
  return timeoutMs;
}

export function v1SideEffectReconciliationRequestFingerprint(
  identity:
    | V1SideEffectReconciliationLogicalIdentity
    | V1SideEffectReconciliationIdentity,
) {
  const value =
    canonicalizeV1SideEffectReconciliationLogicalIdentity(identity);
  return canonicalSha256({
    schemaVersion: 1,
    sideEffectId: value.sideEffectId,
    intentId: value.intentId,
    projectId: value.projectId,
    environmentName: value.environmentName,
    operationId: value.operationId,
    idempotencyKey: value.idempotencyKey,
    adapterId: value.adapterId,
    inspectionFingerprint: value.inspectionFingerprint,
    effectRequestFingerprint: value.effectRequestFingerprint,
  });
}

export function validateV1ReadOnlySideEffectEvidence(
  value: unknown,
): V1ReadOnlySideEffectEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new V1SideEffectReconciliationError(
      "SIDE_EFFECT_RECONCILIATION_CONTRACT_INVALID",
    );
  }
  const record = value as Record<string, unknown>;
  const evidenceFingerprint = record.evidenceFingerprint;
  if (typeof evidenceFingerprint !== "string" || !HASH.test(
    evidenceFingerprint,
  )) {
    throw new V1SideEffectReconciliationError(
      "SIDE_EFFECT_RECONCILIATION_CONTRACT_INVALID",
    );
  }
  if (
    record.classification === "succeeded"
    && exactKeys(
      record,
      [
        "classification",
        "safeEvidenceCode",
        "evidenceFingerprint",
        "resultFingerprint",
      ],
      ["externalReferenceHash"],
    )
    && typeof record.safeEvidenceCode === "string"
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
    assertSafeOwnershipFailureCode(record.safeEvidenceCode);
    return Object.freeze({
      classification: "succeeded",
      safeEvidenceCode: record.safeEvidenceCode,
      evidenceFingerprint,
      resultFingerprint: record.resultFingerprint,
      externalReferenceHash:
        record.externalReferenceHash as string | null | undefined,
    });
  }
  if (
    record.classification === "failed"
    && exactKeys(
      record,
      ["classification", "safeFailureCode", "evidenceFingerprint"],
    )
    && typeof record.safeFailureCode === "string"
  ) {
    assertSafeOwnershipFailureCode(record.safeFailureCode);
    return Object.freeze({
      classification: "failed",
      safeFailureCode: record.safeFailureCode,
      evidenceFingerprint,
    });
  }
  if (
    record.classification === "pending"
    && exactKeys(
      record,
      ["classification", "safeEvidenceCode", "evidenceFingerprint"],
    )
    && typeof record.safeEvidenceCode === "string"
  ) {
    assertSafeOwnershipFailureCode(record.safeEvidenceCode);
    return Object.freeze({
      classification: "pending",
      safeEvidenceCode: record.safeEvidenceCode,
      evidenceFingerprint,
    });
  }
  if (
    record.classification === "manual_review"
    && exactKeys(
      record,
      ["classification", "safeFailureCode", "evidenceFingerprint"],
    )
    && typeof record.safeFailureCode === "string"
  ) {
    assertSafeOwnershipFailureCode(record.safeFailureCode);
    return Object.freeze({
      classification: "manual_review",
      safeFailureCode: record.safeFailureCode,
      evidenceFingerprint,
    });
  }
  throw new V1SideEffectReconciliationError(
    "SIDE_EFFECT_RECONCILIATION_CONTRACT_INVALID",
  );
}

export function safeInconclusiveReconciliationEvidence(
  sideEffectId: string,
  requestFingerprint: string,
  safeCode:
    | "RECONCILIATION_INSPECTION_FAILED"
    | "RECONCILIATION_INSPECTION_TIMED_OUT"
    | "RECONCILIATION_INSPECTION_CANCELLED"
    | "RECONCILIATION_OWNERSHIP_LOST",
): V1ReadOnlySideEffectEvidence {
  const evidenceFingerprint = canonicalSha256({
    schemaVersion: 1,
    sideEffectId,
    requestFingerprint,
    safeCode,
  });
  return safeCode === "RECONCILIATION_INSPECTION_FAILED"
    ? Object.freeze({
        classification: "manual_review" as const,
        safeFailureCode: safeCode,
        evidenceFingerprint,
      })
    : Object.freeze({
        classification: "pending" as const,
        safeEvidenceCode: safeCode,
        evidenceFingerprint,
      });
}
