import { ReleaseLaneOwnershipError } from "./inactive-release-lane-ownership.types";

const ENVIRONMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR = /^[A-Za-z0-9._:@/-]{1,160}$/;

export function normalizeReleaseLaneEnvironment(value: unknown): string {
  if (typeof value !== "string") {
    throw new ReleaseLaneOwnershipError("OWNERSHIP_INPUT_INVALID");
  }
  const normalized = value.trim().toLowerCase();
  if (!ENVIRONMENT.test(normalized)) {
    throw new ReleaseLaneOwnershipError("OWNERSHIP_INPUT_INVALID");
  }
  return normalized;
}

export function assertReleaseLaneOwnershipInput(input: {
  projectId: string;
  environmentName: string;
  lane: string;
  leaseId: string;
  actorId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  leaseTtlMs: number;
}) {
  if (
    !UUID.test(input.projectId)
    || !ENVIRONMENT.test(input.environmentName)
    || (input.lane !== "legacy" && input.lane !== "v1")
    || !UUID.test(input.leaseId)
    || !ACTOR.test(input.actorId)
    || !HASH.test(input.idempotencyKey)
    || !HASH.test(input.requestFingerprint)
    || !Number.isInteger(input.leaseTtlMs)
    || input.leaseTtlMs < 5_000
    || input.leaseTtlMs > 300_000
  ) {
    throw new ReleaseLaneOwnershipError("OWNERSHIP_INPUT_INVALID");
  }
}
