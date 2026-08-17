import { assertPreExecutionLeaseTtl } from "./v1-pre-execution-ownership.pure";

export function canonicalExecutionLeaseHeartbeatInterval(
  leaseTtlMs: number,
  intervalMs?: number,
) {
  const ttl = assertPreExecutionLeaseTtl(leaseTtlMs);
  const value = intervalMs ?? Math.max(100, Math.floor(ttl / 3));
  if (
    !Number.isInteger(value)
    || value < 100
    || value >= Math.floor(ttl / 2)
  ) {
    throw new Error("Execution lease heartbeat interval is invalid.");
  }
  return value;
}
