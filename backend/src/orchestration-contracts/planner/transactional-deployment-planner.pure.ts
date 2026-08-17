import { createHash } from "crypto";
import { canonicalSha256 } from "../contracts/canonical-json";
import { DeploymentClassification } from "../contracts/deployment-intent.types";

export type PlannerBlockerV1 = {
  code: string;
  message: string;
  source: string;
};

export type PlannerClassificationInputV1 = {
  blockers: PlannerBlockerV1[];
  hasAppliedInfrastructure: boolean;
  appliedInfrastructureSpecHash: string | null;
  desiredInfrastructureSpecHash: string;
  stableReleaseSpecHash: string | null;
  desiredReleaseSpecHash: string;
};

export function canonicalPlannerIdempotencyKey(
  projectId: string,
  environmentName: string,
  actorIdentity: string,
  clientIdempotencyKey: string,
) {
  return createHash("sha256")
    .update(`v1\n${projectId}\n${environmentName}\n${actorIdentity}\n${clientIdempotencyKey}`)
    .digest("hex");
}

export function plannerRequestFingerprint(input: {
  kind: string;
  requestedCommitSha: string | null;
  deploymentContractHash: string | null;
  configurationFingerprint: string | null;
  desiredInfrastructureSpecHash: string | null;
  desiredReleaseSpecHash: string | null;
  sourcePipelineRunId: string | null;
  recoveryCode: string | null;
}) {
  return canonicalSha256(input);
}

export function classifyDeployment(input: PlannerClassificationInputV1): DeploymentClassification {
  if (input.blockers.length) return "unsafe_or_unknown";
  if (
    !input.hasAppliedInfrastructure
    || input.appliedInfrastructureSpecHash !== input.desiredInfrastructureSpecHash
  ) {
    return "infrastructure_change";
  }
  if (input.stableReleaseSpecHash !== input.desiredReleaseSpecHash) {
    return "release_only";
  }
  return "no_op";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function changedCanonicalPaths(
  previous: unknown,
  desired: unknown,
  prefix = "",
): string[] {
  if (previous === undefined || desired === undefined) {
    return previous === desired ? [] : [prefix || "$"];
  }
  if (canonicalSha256(previous) === canonicalSha256(desired)) return [];
  if (isRecord(previous) && isRecord(desired)) {
    const keys = [...new Set([...Object.keys(previous), ...Object.keys(desired)])].sort();
    return keys.flatMap((key) => changedCanonicalPaths(
      previous[key],
      desired[key],
      prefix ? `${prefix}.${key}` : key,
    ));
  }
  if (Array.isArray(previous) && Array.isArray(desired)) {
    return [prefix || "$"];
  }
  return [prefix || "$"];
}

export function infrastructureCategories(paths: string[]) {
  const categories = new Set<string>();
  for (const path of paths) {
    const root = path.split(".")[0];
    const category = root === "ecsFoundation"
      ? "ecs_foundation"
      : root === "iamPolicyRevision"
        ? "iam"
        : root;
    if ([
      "network", "registry", "ecs_foundation", "ingress", "database", "storage",
      "discovery", "observability", "iam", "tags",
    ].includes(category)) {
      categories.add(category);
    }
  }
  return [...categories].sort();
}

export function destructiveInfrastructurePaths(
  previous: unknown,
  desired: unknown,
  changedPaths: string[],
) {
  const read = (value: unknown, path: string) => path
    .split(".")
    .reduce<unknown>((current, segment) => isRecord(current) ? current[segment] : undefined, value);
  return changedPaths.filter((path) => {
    const before = read(previous, path);
    const after = read(desired, path);
    return before !== undefined && before !== null
      && (after === undefined || after === null || after === false || after === "none");
  });
}
