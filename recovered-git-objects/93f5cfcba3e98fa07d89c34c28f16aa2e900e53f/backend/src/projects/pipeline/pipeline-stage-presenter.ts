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
