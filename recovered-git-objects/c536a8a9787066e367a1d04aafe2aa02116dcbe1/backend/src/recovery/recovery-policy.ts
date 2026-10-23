import { BadRequestException, ConflictException } from "@nestjs/common";
import { createHash } from "crypto";

export const RECOVERY_RUNBOOKS = [
  { id: "verified_rollback", version: 1, title: "Restore the verified previous release", maxAttempts: 1, timeoutSeconds: 900, preconditions: ["Verified incident", "Immutable immediate rollback release", "Complete ownership and cost evidence", "Exact human approval"] },
  { id: "idempotent_retry", version: 1, title: "Retry a safely recoverable deployment", maxAttempts: 3, timeoutSeconds: 900, preconditions: ["Verified incident", "Failed exact-SHA operation permits SAFE_NOW retry", "Complete ownership and cost evidence", "Exact human approval"] },
  { id: "ecs_restart", version: 1, title: "Restart one owned ECS service", maxAttempts: 2, timeoutSeconds: 600, preconditions: ["Verified incident", "Exact customer-bound service and project tags", "Verified scoped mutation authority", "Exact human approval"] },
  { id: "bounded_replicas", version: 1, title: "Adjust one owned ECS service within 1–4 replicas", maxAttempts: 1, timeoutSeconds: 600, preconditions: ["Verified incident", "Exact customer-bound service and project tags", "Complete per-replica cost evidence", "Exact human approval"] },
] as const;
export type RecoveryRunbookId = typeof RECOVERY_RUNBOOKS[number]["id"];
export function recoveryFingerprint(value: unknown): string {
  function canonical(item: any): any { return Array.isArray(item) ? item.map(canonical) : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])])) : item; }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function recoveryRunbook(id: string) { const entry = RECOVERY_RUNBOOKS.find((book) => book.id === id); if (!entry) throw new BadRequestException("Unknown recovery runbook."); return entry; }
export function assertRecoveryBudget(monthlyCost: unknown, limit: number, currentReplicas: number, requestedReplicas: number) {
  if (typeof monthlyCost !== "number" || !Number.isFinite(monthlyCost) || monthlyCost < 0) throw new ConflictException("Verified monthly cost evidence is required before recovery.");
  if (!Number.isFinite(limit) || limit < 0 || limit > 1000000) throw new BadRequestException("Invalid recovery monthly budget.");
  if (!Number.isInteger(currentReplicas) || currentReplicas < 1 || !Number.isInteger(requestedReplicas) || requestedReplicas < 1 || requestedReplicas > 4) throw new BadRequestException("Recovery replicas must remain between one and four.");
  // Scaling the entire known bill is a conservative ceiling; uncertain or incomplete pricing blocks execution.
  const ceiling = monthlyCost * Math.max(1, requestedReplicas / currentReplicas);
  if (ceiling > limit) throw new ConflictException("Recovery would exceed its approved monthly cost ceiling.");
  return ceiling;
}
export function recoveryOutcome(evidence: { infrastructure: unknown; application: unknown; identityMatches: boolean }): "resolved" | "failed" | "unverified" {
  if (!evidence.identityMatches) return "unverified";
  if (evidence.application === "failed" || evidence.infrastructure === false) return "failed";
  return evidence.application === "healthy" && evidence.infrastructure === true ? "resolved" : "unverified";
}
export function ecsRecoveryVerified(service: any, expected: { serviceArn: string; clusterArn: string; taskDefinitionArn: string; replicas: number; deploymentId: string }) {
  if (!service || !expected.deploymentId || service.serviceArn !== expected.serviceArn || service.clusterArn !== expected.clusterArn || service.taskDefinition !== expected.taskDefinitionArn || service.desiredCount !== expected.replicas || service.runningCount !== expected.replicas || service.pendingCount !== 0) return false;
  const primary = service.deployments?.find((deployment: any) => deployment.status === "PRIMARY");
  return primary?.id === expected.deploymentId && primary.rolloutState === "COMPLETED";
}
export function validateRepairFiles(files: Array<{ path: string; content: string }>) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 10) throw new BadRequestException("Repair patches must change one to ten existing application files.");
  const paths = new Set<string>(); let bytes = 0;
  for (const file of files) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.\/-]{0,199}$/.test(file.path)
      || file.path.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith("."))
      || /(^|\/)(node_modules|vendor|secrets)(\/|$)/i.test(file.path) || !/\.(?:[cm]?jsx?|tsx?|py|json|css|html|md)$/.test(file.path)
      || /(?:^|\/)(?:package(?:-lock)?\.json|.*lock.*|.*secret.*|.*credential.*)$/i.test(file.path) || paths.has(file.path)) throw new BadRequestException("Repair path exceeds the approved application-file scope.");
    paths.add(file.path); bytes += Buffer.byteLength(file.content);
  }
  if (bytes > 128 * 1024) throw new BadRequestException("Repair patch exceeds 128 KiB.");
}
