import { BuildPlan } from "./build-plan";

export type BuildPlanReadinessStatus = "READY" | "READY_WITH_WARNINGS" | "INPUT_REQUIRED" | "BLOCKED";
export type BuildPlanReadiness = {
  status: BuildPlanReadinessStatus;
  warnings: string[];
  blockers: string[];
  requiredInputs: string[];
};

const ENTRYPOINT_INPUT = /(?:start command|production start|application target|entrypoint|output directory).*could not be inferred|(?:requires?|applications require) a production (?:start|build)(?: script| command)/i;

export function evaluateBuildPlanReadiness(
  plan: BuildPlan,
  configuration: { unresolvedRequiredValues?: string[]; blockers?: string[] } = {},
): BuildPlanReadiness {
  const requiredInputs = [...new Set([
    ...(configuration.unresolvedRequiredValues || []),
    ...(plan.requiredUserInputs || []),
    ...plan.blockers.filter((message) => ENTRYPOINT_INPUT.test(message)).map(() => "EXECUTABLE_ENTRYPOINT"),
  ])].sort();
  const configurationBlockers = (configuration.blockers || [])
    .filter((message) => !/^Required application configuration is unresolved:/i.test(message));
  const blockers = [...new Set([...plan.blockers.filter((message) => !ENTRYPOINT_INPUT.test(message)), ...configurationBlockers])];
  const warnings = [...new Set(plan.warnings)];
  return {
    status: blockers.length ? "BLOCKED" : requiredInputs.length ? "INPUT_REQUIRED" : warnings.length ? "READY_WITH_WARNINGS" : "READY",
    warnings,
    blockers,
    requiredInputs,
  };
}
