export const RECOVERY_STAGES = [
  "repo_clone", "stack_detection", "preflight", "dockerfile_generation", "docker_build",
  "security_scan", "ecr_push", "terraform_plan", "terraform_apply", "database_tier_setup",
  "ecs_task_definition_update", "ecs_service_deploy", "health_check", "stable_release",
  "cleanup_inventory", "cleanup_safe_leftovers",
] as const;
export type RecoveryStage = typeof RECOVERY_STAGES[number];

export type StageResumeDecision = {
  mode: "full" | "resume" | "cleanup";
  resumeFromStage: RecoveryStage;
  skippedStages: RecoveryStage[];
  rerunStages: RecoveryStage[];
  reason: string;
  fallbackReason: string | null;
  sourcePipelineRunId: string | null;
  sourceImageUri: string | null;
  sourceImageTag: string | null;
};

export const RECOVERY_STAGE_LABELS: Record<RecoveryStage, string> = {
  repo_clone: "Repository", stack_detection: "Stack detection", preflight: "Pre-flight",
  dockerfile_generation: "Container template", docker_build: "Image build", security_scan: "Security scan",
  ecr_push: "Image registry", terraform_plan: "Infrastructure plan", terraform_apply: "Infrastructure update",
  database_tier_setup: "Database setup", ecs_task_definition_update: "Service configuration",
  ecs_service_deploy: "Application redeploy", health_check: "Health verification", stable_release: "Stable release",
  cleanup_inventory: "Resource inventory", cleanup_safe_leftovers: "Safe cleanup",
};
