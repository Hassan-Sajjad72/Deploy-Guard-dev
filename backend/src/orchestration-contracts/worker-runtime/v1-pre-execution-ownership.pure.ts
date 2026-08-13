import { DeployGuardWorkerEnvelopeV1 } from "../contracts/worker-envelope.types";
import {
  PreExecutionOperation,
} from "./v1-pre-execution-ownership.types";

export function preExecutionOperationForEnvelope(
  envelope: DeployGuardWorkerEnvelopeV1,
): PreExecutionOperation {
  if (
    envelope.protocol.messageType === "intent.release.execute"
    && envelope.routing.lane === "release"
    && envelope.routing.operation === "execute"
  ) {
    return { lane: "release", scope: "execute" };
  }
  if (
    envelope.protocol.messageType === "intent.infrastructure.plan"
    && envelope.routing.lane === "infrastructure"
    && envelope.routing.operation === "plan"
  ) {
    return { lane: "infrastructure", scope: "plan" };
  }
  if (
    envelope.protocol.messageType === "intent.infrastructure.apply"
    && envelope.routing.lane === "infrastructure"
    && envelope.routing.operation === "apply"
  ) {
    return { lane: "infrastructure", scope: "apply" };
  }
  if (
    envelope.protocol.messageType === "intent.deletion.execute"
    && envelope.routing.lane === "deletion"
    && envelope.routing.operation === "destroy"
  ) {
    return { lane: "deletion", scope: "destroy" };
  }
  throw new Error("Envelope has no frozen pre-execution operation.");
}

export function preExecutionOperationsConflict(
  requested: PreExecutionOperation,
  active: PreExecutionOperation,
) {
  if (requested.lane === "deletion" || active.lane === "deletion") return true;
  if (requested.lane === "infrastructure" && requested.scope === "apply") {
    return true;
  }
  if (active.lane === "infrastructure" && active.scope === "apply") return true;
  if (requested.lane === "release" && active.lane === "release") return true;
  if (
    requested.lane === "infrastructure"
    && active.lane === "infrastructure"
  ) {
    return true;
  }
  return false;
}

export function assertPreExecutionLeaseTtl(leaseTtlMs: number) {
  if (
    !Number.isInteger(leaseTtlMs)
    || leaseTtlMs < 1_000
    || leaseTtlMs > 15 * 60_000
  ) {
    throw new Error("Pre-execution lease TTL is invalid.");
  }
  return leaseTtlMs;
}

export function assertSafeOwnershipFailureCode(code: string) {
  if (!/^[A-Z][A-Z0-9_]{2,127}$/.test(code)) {
    throw new Error("Ownership failure code is invalid.");
  }
  return code;
}
