export type TerraformPlanSafetySummary = {
  create: number;
  update: number;
  replace: number;
  delete: number;
  noOp: number;
  resourceTypes: string[];
};

export type TerraformPlanSafetyReview = {
  safe: boolean;
  summary: TerraformPlanSafetySummary;
  violations: Array<{ code: string; address: string; type: string }>;
};

export function reviewGithubActionsTerraformPlan(
  raw: string,
  scope: { projectId: string; environment: "dev" | "production"; infrastructureNamespace: string },
  recovery?: { persistentState: "NONE" | "PERSISTENT"; recoveryEvidenceAvailable: boolean },
): TerraformPlanSafetyReview {
  const parsed = JSON.parse(raw || "{}") as { resource_changes?: Array<Record<string, unknown>> };
  const changes = Array.isArray(parsed.resource_changes) ? parsed.resource_changes : [];
  const counts = { create: 0, update: 0, replace: 0, delete: 0, noOp: 0 };
  const resourceTypes = new Set<string>();
  const violations: TerraformPlanSafetyReview["violations"] = [];
  for (const item of changes) {
    const change = record(item.change);
    const actions = Array.isArray(change.actions) ? change.actions.filter((value): value is string => typeof value === "string") : [];
    const type = typeof item.type === "string" ? item.type : "unknown";
    const address = typeof item.address === "string" ? item.address : "unknown";
    resourceTypes.add(type);
    if (actions.includes("create") && actions.includes("delete")) counts.replace += 1;
    else if (actions.includes("create")) counts.create += 1;
    else if (actions.includes("update")) counts.update += 1;
    else if (actions.includes("delete")) counts.delete += 1;
    else counts.noOp += 1;

    const deletes = actions.includes("delete");
    if (/^aws_secretsmanager_secret(?:_version)?$|^aws_efs_(?:file_system|access_point)$/.test(type) && deletes
      && recovery?.persistentState !== "NONE" && recovery?.recoveryEvidenceAvailable !== true) {
      violations.push({ code: "retained_resource_delete", address, type });
    }
    if (type === "aws_cloudwatch_log_group" && deletes) {
      violations.push({ code: "owned_log_group_delete", address, type });
    }
    if (type === "aws_secretsmanager_secret_version" && actions.includes("create") && change.before !== null && change.before !== undefined) {
      violations.push({ code: "needless_secret_version", address, type });
    }
    const identity = record(record(change.after).tags || record(change.before).tags);
    if (identity.ManagedBy === "DeployGuard" && (identity.DeployGuardProjectId !== scope.projectId || identity.Environment !== scope.environment)) {
      violations.push({ code: "ownership_scope_mismatch", address, type });
    }
    const name = String(record(change.after).name || record(change.before).name || "");
    if (
      (name.startsWith("/deployguard/") && !name.startsWith(`${scope.infrastructureNamespace}/`))
      || (name.startsWith("deployguard/") && !name.startsWith(`deployguard/${scope.projectId}/${scope.environment}/`))
    ) {
      violations.push({ code: "cross_project_namespace", address, type });
    }
  }
  return {
    safe: violations.length === 0,
    summary: { ...counts, resourceTypes: [...resourceTypes].filter((type) => /^aws_[a-z0-9_]+$/.test(type)).sort() },
    violations,
  };
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
