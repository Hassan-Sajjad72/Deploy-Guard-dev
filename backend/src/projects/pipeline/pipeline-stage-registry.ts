export type PipelineStageDefinition = {
  key: string;
  label: string;
  order: number;
  required: boolean;
  canSkip: boolean;
  source: string;
  lifecycleKey: string;
  lifecycleLabel: string;
  lifecycleOrder: number;
  aliases: string[];
};

function stage(
  key: string,
  label: string,
  order: number,
  required: boolean,
  canSkip: boolean,
  source: string,
  lifecycleKey: string,
  lifecycleLabel: string,
  lifecycleOrder: number,
  aliases: string[] = []
): PipelineStageDefinition {
  return {
    key,
    label,
    order,
    required,
    canSkip,
    source,
    lifecycleKey,
    lifecycleLabel,
    lifecycleOrder,
    aliases: [key, ...aliases],
  };
}

/**
 * Canonical VERSION-14 pipeline registry.
 *
 * Event aliases are intentionally retained so historical runs remain
 * renderable without rewriting persisted evidence.
 */
export const PIPELINE_STAGE_REGISTRY: readonly PipelineStageDefinition[] = [
  stage("validate_inputs", "Validate Inputs", 10, true, false, "pipeline", "validate_inputs", "Validate inputs", 10, ["queued", "preparing", "readiness_check"]),
  stage("clone_repository", "Clone Repository", 30, true, false, "pipeline", "clone_repository", "Clone repository", 30, ["cloning", "repo_clone"]),
  stage("stack_detection_snapshot", "Stack Detection Snapshot", 34, true, false, "detection", "stack_detection_snapshot", "Detect application", 34, ["stack_detection"]),
  stage("deep_repo_scan", "Deep Repository Scan", 37, true, false, "detection", "deployability_preflight", "Verify deployability", 40),
  stage("runtime_contract_detection", "Runtime Contract Detection", 40, true, false, "detection", "deployability_preflight", "Verify deployability", 40),
  stage("deployability_preflight_gate", "Deployability Pre-flight Gate", 45, true, false, "preflight", "deployability_preflight", "Verify deployability", 40, ["preflight"]),
  stage("external_ci_validation", "Optional External CI", 47, false, true, "github_actions", "external_ci_validation", "External CI validation", 47, ["github_actions"]),
  stage("template_generation", "Template Generation", 50, true, false, "templates", "container_configuration", "Generate and check container configuration", 50, ["dockerfile_generated", "dockerignore_generated", "dockerfile_generation"]),
  stage("dockerfile_security_check", "Dockerfile Security Check", 60, true, false, "dockerfile", "container_configuration", "Generate and check container configuration", 50, ["dockerfile_check"]),
  stage("docker_build", "Docker Build", 70, true, false, "docker", "docker_build", "Build image", 60, ["building_image"]),
  stage("trivy_image_scan", "Trivy Image Scan", 80, false, true, "security", "security_review", "Scan image and evaluate security policy", 70, ["trivy_scan", "security_scan"]),
  stage("security_gate", "Security Gate", 90, true, false, "security", "security_review", "Scan image and evaluate security policy", 70, ["security_policy"]),
  stage("ecr_push", "ECR Push", 100, true, false, "ecr", "ecr_push", "Push immutable image to ECR", 80, ["tagging_image", "ecr_"]),
  stage("terraform_plan", "Terraform Plan", 110, true, false, "terraform", "terraform_plan", "Lock state and prepare Terraform plan", 90, ["terraform_stage", "infrastructure_plan", "terraform_plan_lock", "state_lock_plan"]),
  stage("finops_estimate", "FinOps Estimate", 120, true, false, "finops", "finops", "Estimate cost and enforce FinOps gate", 100, ["cost_analysis", "cost_breakdown", "cost_policy"]),
  stage("cost_gate", "Cost Gate", 130, true, false, "finops", "finops", "Estimate cost and enforce FinOps gate", 100, ["cost_approval", "cost_threshold", "deployment_blocked_by_cost", "cost_approved", "cost_analysis_passed", "cost_gate"]),
  stage("terraform_apply_gate", "Terraform Apply Gate", 140, true, false, "configuration", "terraform_apply_gate", "Apply configuration gate", 110, ["infrastructure_apply_disabled_by_config", "terraform_apply_approval"]),
  stage("terraform_apply", "Terraform Apply", 150, true, false, "terraform", "terraform_apply", "Lock state and provision infrastructure", 120, ["infrastructure_apply", "terraform_apply_lock", "state_lock_apply"]),
  stage("database_tier_setup", "Database Setup", 155, false, true, "database", "database_tier_setup", "Configure application database", 125, ["database_tier"]),
  stage("efs", "Persistent Storage / EFS", 160, false, true, "storage", "efs", "Provision optional storage", 130, ["storage_", "persistent_storage", "efs_", "backup_plan"]),
  stage("ecs_deploy", "ECS Deploy", 170, true, false, "orchestration", "ecs_deploy", "Deploy ECS service", 140, ["ecs_cluster", "ecs_task", "ecs_service", "fargate_spot", "autoscaling", "spot_interruption", "ecs_task_definition_update", "ecs_service_deploy"]),
  stage("alb_health", "ALB / Application Health", 180, true, false, "orchestration", "alb_health", "Validate application health", 150, ["alb_", "health_check"]),
  stage("stable_release", "Stable Release", 190, true, false, "orchestration", "stable_release", "Mark stable release", 160, ["deployment_marked_stable", "deployment_completed"]),
  stage("observability", "Observability Readiness", 200, false, true, "observability", "observability", "Record observability readiness", 170),
  stage("complete", "Complete", 210, true, false, "pipeline", "complete", "Complete", 180, ["completed"]),
] as const;

export function matchesPipelineStage(definition: PipelineStageDefinition, eventStage: string) {
  const normalized = String(eventStage || "").toLowerCase();
  return definition.aliases.some((alias) => normalized === alias || normalized.startsWith(`${alias}_`) || (alias.endsWith("_") && normalized.startsWith(alias)));
}

export function pipelineStageDefinition(key: string) {
  return PIPELINE_STAGE_REGISTRY.find((definition) => definition.key === key) || null;
}

export const PIPELINE_LIFECYCLE_REGISTRY = Array.from(
  new Map(
    PIPELINE_STAGE_REGISTRY.map((definition) => [
      definition.lifecycleKey,
      {
        key: definition.lifecycleKey,
        label: definition.lifecycleLabel,
        order: definition.lifecycleOrder,
      },
    ])
  ).values()
).sort((left, right) => left.order - right.order);
