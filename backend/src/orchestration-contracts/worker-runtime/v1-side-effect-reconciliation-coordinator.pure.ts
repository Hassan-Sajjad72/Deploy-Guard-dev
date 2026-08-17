import { canonicalSha256 } from "../contracts/canonical-json";
import {
  V1SideEffectReconciliationCoordinatorError,
} from "./v1-side-effect-reconciliation-coordinator.types";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKER_ID = /^[a-zA-Z0-9][a-zA-Z0-9:_.-]{2,255}$/;

export function assertV1ReconciliationCoordinatorClaim(input: {
  sideEffectId: string;
  workerId: string;
  leaseTtlMs: number;
  inspectionTimeoutMs: number;
}) {
  if (
    !UUID.test(input.sideEffectId)
    || !WORKER_ID.test(input.workerId)
    || !Number.isInteger(input.leaseTtlMs)
    || input.leaseTtlMs < 1_000
    || input.leaseTtlMs > 15 * 60_000
    || input.leaseTtlMs < input.inspectionTimeoutMs + 250
  ) {
    throw new V1SideEffectReconciliationCoordinatorError(
      "RECONCILIATION_COORDINATOR_CONTRACT_INVALID",
    );
  }
  return Object.freeze({ ...input });
}

export function abandonedReconciliationEvidenceFingerprint(input: {
  sideEffectId: string;
  reconciliationId: string;
  requestFingerprint: string;
  leaseId: string;
  fencingToken: string;
}) {
  if (
    !UUID.test(input.sideEffectId)
    || !UUID.test(input.reconciliationId)
    || !UUID.test(input.leaseId)
    || !/^[0-9a-f]{64}$/.test(input.requestFingerprint)
    || !/^[1-9][0-9]*$/.test(input.fencingToken)
  ) {
    throw new V1SideEffectReconciliationCoordinatorError(
      "RECONCILIATION_COORDINATOR_CONTRACT_INVALID",
    );
  }
  return canonicalSha256({
    schemaVersion: 1,
    sideEffectId: input.sideEffectId,
    reconciliationId: input.reconciliationId,
    requestFingerprint: input.requestFingerprint,
    leaseId: input.leaseId,
    fencingToken: input.fencingToken,
    classification: "pending",
    safeEvidenceCode: "RECONCILIATION_PREVIOUS_INSPECTION_ABANDONED",
  });
}
