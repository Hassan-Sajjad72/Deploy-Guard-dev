import { canonicalSha256 } from "./canonical-json";

export type AutomaticInfrastructurePolicyState =
  | "auto_approved"
  | "owner_required"
  | "owner_approved"
  | "operator_required"
  | "operator_approved"
  | "platform_attention";

export type AutomaticInfrastructurePolicy = Readonly<{
  schemaVersion: 1;
  state: AutomaticInfrastructurePolicyState;
  approvalRequired: boolean;
  evidenceHash: string;
  planHash: string;
  thresholdMonthlyCost: number;
  maxResourceChanges: number;
  monthlyCost: number | null;
  currency: string | null;
  resourceSummary: Readonly<{
    create: number;
    update: number;
    replace: number;
    delete: number;
  }> | null;
}>;

export function decideAutomaticInfrastructurePolicy(input: {
  planHash: string | null;
  costEstimate: {
    state: "real" | "deferred" | "unavailable" | "stale" | "mismatch";
    currency: string | null;
    monthlyCost: number | null;
  };
  resourceSummary: {
    create: number;
    update: number;
    replace: number;
    delete: number;
  } | null;
  thresholdMonthlyCost: number;
  maxResourceChanges: number;
}): AutomaticInfrastructurePolicy {
  const planHash = /^[0-9a-f]{64}$/.test(input.planHash || "")
    ? input.planHash!
    : "";
  const threshold = finiteNonNegative(input.thresholdMonthlyCost) ? input.thresholdMonthlyCost : 25;
  const maxChanges = Number.isInteger(input.maxResourceChanges) && input.maxResourceChanges > 0
    ? input.maxResourceChanges
    : 100;
  const summary = validSummary(input.resourceSummary) ? {
    create: input.resourceSummary.create,
    update: input.resourceSummary.update,
    replace: input.resourceSummary.replace,
    delete: input.resourceSummary.delete,
  } : null;
  const realCost = input.costEstimate.state === "real"
    && finiteNonNegative(input.costEstimate.monthlyCost)
    && /^[A-Z]{3}$/.test(input.costEstimate.currency || "");
  const totalChanges = summary
    ? summary.create + summary.update + summary.replace + summary.delete
    : Number.POSITIVE_INFINITY;
  const destructive = Boolean(summary && (summary.replace > 0 || summary.delete > 0));

  const state: AutomaticInfrastructurePolicyState = !planHash || !summary || !realCost
    ? "platform_attention"
    : destructive || totalChanges > maxChanges
      ? "operator_required"
      : input.costEstimate.monthlyCost! > threshold
        ? "owner_required"
        : "auto_approved";
  const evidence = {
    schemaVersion: 1,
    planHash,
    thresholdMonthlyCost: threshold,
    maxResourceChanges: maxChanges,
    monthlyCost: realCost ? input.costEstimate.monthlyCost : null,
    currency: realCost ? input.costEstimate.currency : null,
    resourceSummary: summary,
  } as const;
  return Object.freeze({
    ...evidence,
    state,
    approvalRequired: state !== "auto_approved",
    evidenceHash: canonicalSha256(evidence),
  });
}

export function isApprovedInfrastructurePolicy(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  return policy.schemaVersion === 1
    && policy.approvalRequired === false
    && ["auto_approved", "owner_approved", "operator_approved"].includes(String(policy.state))
    && /^[0-9a-f]{64}$/.test(String(policy.evidenceHash || ""));
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validSummary(value: AutomaticInfrastructurePolicy["resourceSummary"]): value is NonNullable<AutomaticInfrastructurePolicy["resourceSummary"]> {
  return Boolean(value && [value.create, value.update, value.replace, value.delete]
    .every((count) => Number.isInteger(count) && count >= 0));
}
