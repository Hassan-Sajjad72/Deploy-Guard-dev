import {
  matchesPipelineStage,
  pipelineStageDefinition,
  PIPELINE_STAGE_REGISTRY,
} from "./pipeline-stage-registry";

export function presentPipelineStage(internalStage: string) {
  const normalized = String(internalStage || "").toLowerCase();
  const definition =
    pipelineStageDefinition(normalized) ||
    PIPELINE_STAGE_REGISTRY.find((candidate) =>
      matchesPipelineStage(candidate, normalized)
    );
  return definition
    ? { key: definition.lifecycleKey, label: definition.lifecycleLabel }
    : { key: "validate_inputs", label: "Validate inputs" };
}

export function normalizePipelineFailureClass(
  value: unknown,
  currentStage: unknown = "",
  message: unknown = "",
) {
  const existing = String(value || "").trim().toLowerCase();
  const canonical = new Set([
    "contract_invalid",
    "configuration_changed",
    "plan_policy_failed",
    "approval_expired",
    "plan_artifact_changed",
    "terraform_apply_partial",
    "managed_database_binding_invalid",
    "managed_service_not_ready",
    "runtime_deployment_failed",
    "application_health_failed",
  ]);
  if (canonical.has(existing)) return existing;
  const evidence = `${existing}\n${String(currentStage || "")}\n${String(message || "")}`.toLowerCase();
  if (/contract_invalid|deployment contract.*invalid|pre.?mutation.*contract/i.test(evidence)) return "contract_invalid";
  if (/configuration_changed|configuration changed|deployment contract changed after planning|desired.?state.*changed|binding revision.*changed/i.test(evidence)) return "configuration_changed";
  if (/plan_policy_failed|plan.*policy.*failed|task.definition.*policy/i.test(evidence)) return "plan_policy_failed";
  if (/approval_expired|approval.*expired/i.test(evidence)) return "approval_expired";
  if (/plan_artifact_changed|plan.*(?:changed|swapped|hash.*mismatch)/i.test(evidence)) return "plan_artifact_changed";
  if (/terraform_apply_partial|partial(?:ly)? provision|apply.*partial/i.test(evidence)) return "terraform_apply_partial";
  if (/managed_database_binding_invalid|managed database.*binding|binding secret reference/i.test(evidence)) return "managed_database_binding_invalid";
  if (
    existing === "database_service_unhealthy"
    || /database_service_(?:readiness|unhealthy)|(?:managed )?database service.*(?:not ready|unhealthy)|managed database.*(?:not ready|unhealthy)|cloud map.*(?:missing|not registered)|private connectivity.*(?:unavailable|failed)|efs.*(?:not ready|readiness|mount.*failed)/i.test(evidence)
  ) {
    return "managed_service_not_ready";
  }
  if (
    existing === "health_check_timeout"
    || /application_health_failed|ecs_service_unhealthy|health[_ ]check|alb.*(?:502|503|unhealthy)|target (?:group )?health.*failed|target group.*unhealthy|application.*health.*failed|starts but health/i.test(evidence)
  ) {
    return "application_health_failed";
  }
  if (/ecs.*(?:deploy|service|task).*(?:failed|stopped)|runtime deployment failed/i.test(evidence)) return "runtime_deployment_failed";
  return existing || null;
}

export function pipelineFailureStage(
  failureClass: string | null,
  currentStage: string | null | undefined,
) {
  const stages: Record<string, string> = {
    contract_invalid: "deployability_preflight_gate",
    configuration_changed: "terraform_plan",
    plan_policy_failed: "terraform_plan",
    approval_expired: "terraform_apply_gate",
    plan_artifact_changed: "terraform_apply",
    terraform_apply_partial: "terraform_apply",
    managed_database_binding_invalid: "database_tier_setup",
    managed_service_not_ready: "database_tier_setup",
    runtime_deployment_failed: "ecs_deploy",
    application_health_failed: "alb_health",
  };
  return (failureClass && stages[failureClass]) || currentStage || "failed";
}
