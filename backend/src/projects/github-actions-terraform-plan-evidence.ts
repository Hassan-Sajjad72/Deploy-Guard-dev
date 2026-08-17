export const TERRAFORM_PLAN_EVIDENCE_PREFIX = "DEPLOYGUARD_PLAN_SUMMARY=";

export type GithubActionsTerraformPlanSummary = {
  create: number;
  update: number;
  replace: number;
  delete: number;
  noOp: number;
  resourceTypes: string[];
  safety: "passed";
};

export function extractGithubActionsTerraformPlanSummary(log: string): GithubActionsTerraformPlanSummary | null {
  const line = log.split(/\r?\n/).reverse().find((candidate) => candidate.includes(TERRAFORM_PLAN_EVIDENCE_PREFIX));
  if (!line) return null;
  const payload = line.slice(line.indexOf(TERRAFORM_PLAN_EVIDENCE_PREFIX) + TERRAFORM_PLAN_EVIDENCE_PREFIX.length).trim();
  if (payload.length > 4096) return null;
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const number = (name: string) => Number.isSafeInteger(parsed[name]) && Number(parsed[name]) >= 0 ? Number(parsed[name]) : null;
    const counts = {
      create: number("create"),
      update: number("update"),
      replace: number("replace"),
      delete: number("delete"),
      noOp: number("noOp"),
    };
    if (Object.values(counts).some((value) => value === null) || parsed.safety !== "passed") return null;
    if (!Array.isArray(parsed.resourceTypes) || parsed.resourceTypes.length > 100) return null;
    const resourceTypes = parsed.resourceTypes.filter((value): value is string => typeof value === "string");
    if (resourceTypes.length !== parsed.resourceTypes.length || resourceTypes.some((value) => !/^aws_[a-z0-9_]+$/.test(value))) return null;
    return { ...counts as Record<keyof typeof counts, number>, resourceTypes: [...new Set(resourceTypes)].sort(), safety: "passed" };
  } catch {
    return null;
  }
}
