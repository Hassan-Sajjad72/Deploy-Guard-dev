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
  if (["managed_service_not_ready", "application_health_failed"].includes(existing)) return existing;
  const evidence = `${existing}\n${String(currentStage || "")}\n${String(message || "")}`.toLowerCase();
  if (
    existing === "database_service_unhealthy"
    || /database_service_(?:readiness|unhealthy)|(?:managed )?database service.*(?:not ready|unhealthy)|managed database.*(?:not ready|unhealthy)|cloud map.*(?:missing|not registered)|private connectivity.*(?:unavailable|failed)|efs.*(?:not ready|readiness|mount.*failed)/i.test(evidence)
  ) {
    return "managed_service_not_ready";
  }
  if (
    existing === "health_check_timeout"
    || /application_health_failed|ecs_service_unhealthy|health_check|alb.*(?:502|503|unhealthy)|target group.*unhealthy|application.*health.*failed|starts but health/i.test(evidence)
  ) {
    return "application_health_failed";
  }
  return existing || null;
}
