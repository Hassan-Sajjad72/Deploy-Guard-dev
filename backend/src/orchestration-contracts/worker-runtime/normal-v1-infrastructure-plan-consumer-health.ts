import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { NormalV1InfrastructurePlanConsumerRuntimeStatus } from "./normal-v1-infrastructure-plan-consumer-runtime.service";

const SAFE_CODE = /^[A-Z0-9_]{3,128}$/;
const STATUS_FILE = "TWO_LANE_NORMAL_INFRASTRUCTURE_PLAN_CONSUMER_STATUS_FILE";
type State = "disabled" | "starting" | "ready" | "processing" | "reconciling" | "terminal" | "stopping" | "stopped" | "failed";
export type NormalV1InfrastructurePlanConsumerHealth = Readonly<{
  schemaVersion: 1; state: State; ready: boolean; live: boolean; safeCode: string; observedAt: string;
}>;

export function sanitizeNormalV1InfrastructurePlanConsumerHealth(
  status: NormalV1InfrastructurePlanConsumerRuntimeStatus,
): NormalV1InfrastructurePlanConsumerHealth {
  const state: State = status.state === "blocked" ? "failed"
    : status.state === "idle" ? "ready" : status.state;
  return Object.freeze({
    schemaVersion: 1, state, ready: state === "ready" && status.ready,
    live: !["disabled", "failed", "stopped"].includes(state),
    safeCode: SAFE_CODE.test(status.safeCode)
      ? status.safeCode : "NORMAL_V1_INFRASTRUCTURE_PLAN_CONSUMER_STATUS_INVALID",
    observedAt: new Date().toISOString(),
  });
}

export class NormalV1InfrastructurePlanConsumerHealthFile {
  constructor(private readonly path = process.env[STATUS_FILE] ?? "") {}
  enabled() { return isAbsolute(this.path); }
  write(status: NormalV1InfrastructurePlanConsumerRuntimeStatus) {
    if (!this.enabled()) return;
    const health = sanitizeNormalV1InfrastructurePlanConsumerHealth(status);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(health)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.path);
  }
  writeFailure(safeCode: string) {
    this.write({ state: "blocked", ready: false, safeCode,
      activeMessageType: null, lastOutcome: null });
  }
  read(maxAgeMs = 90_000): NormalV1InfrastructurePlanConsumerHealth {
    if (!this.enabled() || !existsSync(this.path)) return this.unavailable("NORMAL_V1_INFRASTRUCTURE_PLAN_CONSUMER_STATUS_UNAVAILABLE");
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8")) as Partial<NormalV1InfrastructurePlanConsumerHealth>;
      if (value.schemaVersion !== 1 || typeof value.observedAt !== "string" || !SAFE_CODE.test(value.safeCode ?? "") || !["disabled","starting","ready","processing","reconciling","terminal","stopping","stopped","failed"].includes(value.state ?? "")) return this.unavailable("NORMAL_V1_INFRASTRUCTURE_PLAN_CONSUMER_STATUS_INVALID");
      const age = Date.now() - Date.parse(value.observedAt);
      if (!Number.isFinite(age) || age < -5_000 || age > maxAgeMs) return this.unavailable("NORMAL_V1_INFRASTRUCTURE_PLAN_CONSUMER_STATUS_STALE");
      return Object.freeze({ schemaVersion: 1, state: value.state as State, ready: value.ready === true, live: value.live === true, safeCode: value.safeCode!, observedAt: value.observedAt });
    } catch { return this.unavailable("NORMAL_V1_INFRASTRUCTURE_PLAN_CONSUMER_STATUS_INVALID"); }
  }
  private unavailable(safeCode: string): NormalV1InfrastructurePlanConsumerHealth {
    return Object.freeze({ schemaVersion: 1, state: "failed", ready: false, live: false, safeCode, observedAt: new Date().toISOString() });
  }
}
