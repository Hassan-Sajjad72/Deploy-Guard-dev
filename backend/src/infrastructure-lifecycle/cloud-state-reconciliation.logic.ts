export type DeploymentStatus = "not_deployed" | "deploying" | "live" | "unhealthy" | "failed" | "destroyed" | "stale_live_record" | "unknown";
export type HealthStatus = "healthy" | "unhealthy" | "unreachable" | "not_applicable" | "unknown";
export type InfrastructureStatus = "not_provisioned" | "provisioning" | "provisioned" | "destroy_running" | "destroy_completed" | "destroyed" | "destroy_failed" | "unknown";
export type ResourceStatus = "inventory_required" | "inventory_unavailable" | "no_cloud_resources_found" | "active_resources" | "cleanup_required" | "manual_review_required" | "protected_only" | "inventory_error";
export type CleanupStatus = "not_requested" | "destroy_running" | "destroy_completed" | "cleanup_required" | "cleanup_completed" | "cleanup_failed" | "manual_review_required";
export type CloudVerificationStatus = "verified" | "stale" | "verification_required" | "verification_failed" | "auth_required";
export type InventoryStatus = "not_scanned" | "scanned" | "stale" | "unavailable_auth_required" | "error";
export type CloudNextAction = "refresh_inventory" | "verify_cloud_state" | "run_terraform_destroy" | "clean_safe_leftovers" | "review_manual_resources" | "view_ecs_diagnostics" | "retry_deployment" | "mark_destroyed_after_verification" | "no_action";

export type CloudStateInput = {
  storedDeploymentStatus?: string | null;
  hasStoredDeploymentUrl: boolean;
  pipelineStatus?: string | null;
  pipelineProgress?: number | null;
  pipelineFailedStage?: string | null;
  deploymentActivityActive?: boolean;
  environmentStatus?: string | null;
  environmentCleanupStatus?: string | null;
  destroyStatus?: string | null;
  destroyCleanupStatus?: string | null;
  inventoryStatus: InventoryStatus;
  inventorySuccessful: boolean;
  activeResourceCount: number;
  protectedResourceCount: number;
  safeLeftoverCount: number;
  manualReviewCount: number;
  terraformResourceCount: number;
  runtimeResourceCount: number;
  highCostResourceCount: number;
  ecsExists: boolean;
  ecsHealthy: boolean | null;
  targetGroupExists: boolean;
  targetHealthy: boolean | null;
  httpHealthy: boolean | null;
};

export type ReconciledCloudState = {
  deploymentStatus: DeploymentStatus;
  healthStatus: HealthStatus;
  infrastructureStatus: InfrastructureStatus;
  resourceStatus: ResourceStatus;
  cleanupStatus: CleanupStatus;
  cloudVerificationStatus: CloudVerificationStatus;
  inventoryStatus: InventoryStatus;
  adminActionRequired: boolean;
  nextAction: CloudNextAction;
  statusExplanation: string;
};

const activePipeline = new Set(["queued", "running", "waiting_for_approval", "paused"]);
const activeDeployment = new Set(["queued", "deploying", "waiting_for_service_stability", "rollback_started"]);
const failedDeployment = new Set(["failed", "rollback_failed", "interrupted"]);
const healthyDeployment = new Set(["healthy", "rollback_succeeded"]);
const destroyedEnvironment = new Set(["destroyed", "destroy_needs_cleanup"]);

export function isDestroyOperationRelevant(input: {
  destroyCreatedAt?: Date | string | null;
  destroyUpdatedAt?: Date | string | null;
  environmentProvisionedAt?: Date | string | null;
  environmentUpdatedAt?: Date | string | null;
}) {
  const destroyTime = new Date(input.destroyCreatedAt || input.destroyUpdatedAt || 0).getTime();
  const provisionedTime = new Date(input.environmentProvisionedAt || input.environmentUpdatedAt || 0).getTime();
  if (!Number.isFinite(destroyTime) || destroyTime <= 0) return false;
  if (!Number.isFinite(provisionedTime) || provisionedTime <= 0) return true;
  return destroyTime >= provisionedTime;
}

export function hasTerraformMutationEvidence(input: {
  applyCompleted: boolean;
  applyOperationId?: unknown;
  environmentPipelineRunId?: string | null;
  currentPipelineRunId?: string | null;
  terraformOutputs?: Record<string, unknown> | null;
}) {
  return Boolean(
    input.applyCompleted
    || input.applyOperationId
    || (
      input.environmentPipelineRunId
      && input.environmentPipelineRunId === input.currentPipelineRunId
      && Object.keys(input.terraformOutputs || {}).length > 0
    ),
  );
}

export function reconcileCloudState(input: CloudStateInput): ReconciledCloudState {
  const authUnavailable = input.inventoryStatus === "unavailable_auth_required";
  const inventoryError = input.inventoryStatus === "error";
  const inventoryStale = input.inventoryStatus === "stale";
  const destroyRunning = input.destroyStatus === "queued" || input.destroyStatus === "running" || input.environmentStatus === "destroying";
  const destroyCompleted = input.destroyStatus === "completed" || destroyedEnvironment.has(input.environmentStatus || "");
  const destroyFailed = input.destroyStatus === "failed" || input.environmentStatus === "destroy_failed";
  const hasActiveResources = input.activeResourceCount > 0;
  const runtimeEvidence = input.runtimeResourceCount > 0 || input.ecsExists || input.targetGroupExists;
  const verifiedHealthy = input.httpHealthy === true || input.targetHealthy === true || input.ecsHealthy === true;
  const verifiedUnhealthy = input.httpHealthy === false || input.targetHealthy === false || input.ecsHealthy === false;
  const storedHealthy = healthyDeployment.has(input.storedDeploymentStatus || "");

  let infrastructureStatus: InfrastructureStatus = "unknown";
  if (destroyRunning) infrastructureStatus = "destroy_running";
  else if (destroyFailed) infrastructureStatus = "destroy_failed";
  else if (destroyCompleted && input.inventorySuccessful && !hasActiveResources) infrastructureStatus = "destroyed";
  else if (destroyCompleted) infrastructureStatus = "destroy_completed";
  else if (["queued", "planning", "provisioning"].includes(input.environmentStatus || "")) infrastructureStatus = "provisioning";
  else if (["provisioned", "partially_provisioned"].includes(input.environmentStatus || "")) infrastructureStatus = "provisioned";
  else if (!input.environmentStatus || input.environmentStatus === "not_provisioned") infrastructureStatus = "not_provisioned";

  let resourceStatus: ResourceStatus;
  if (authUnavailable) resourceStatus = "inventory_unavailable";
  else if (inventoryError) resourceStatus = "inventory_error";
  else if (input.inventoryStatus === "not_scanned" || inventoryStale) resourceStatus = "inventory_required";
  else if (input.manualReviewCount > 0) resourceStatus = "manual_review_required";
  else if (destroyCompleted && hasActiveResources) resourceStatus = "cleanup_required";
  // A project-owned resource is not residue merely because direct cleanup is
  // technically supported. Residue is actionable only after an intentional
  // destroy has completed and inventory still proves that it remains.
  else if (destroyCompleted && input.safeLeftoverCount > 0) resourceStatus = "cleanup_required";
  else if (hasActiveResources) resourceStatus = "active_resources";
  else if (input.protectedResourceCount > 0 && !destroyCompleted) resourceStatus = "protected_only";
  else resourceStatus = "no_cloud_resources_found";

  let cleanupStatus: CleanupStatus = "not_requested";
  if (destroyRunning) cleanupStatus = "destroy_running";
  else if (destroyFailed) cleanupStatus = "cleanup_failed";
  else if (input.manualReviewCount > 0) cleanupStatus = "manual_review_required";
  else if (destroyCompleted && hasActiveResources) cleanupStatus = "cleanup_required";
  else if (destroyCompleted && input.safeLeftoverCount > 0) cleanupStatus = "cleanup_required";
  else if (destroyCompleted && input.inventorySuccessful) cleanupStatus = "cleanup_completed";
  else if (destroyCompleted) cleanupStatus = "destroy_completed";
  else if (input.environmentCleanupStatus === "cleanup_required") cleanupStatus = "cleanup_required";

  let deploymentStatus: DeploymentStatus = "not_deployed";
  let healthStatus: HealthStatus = "not_applicable";
  if (destroyRunning) {
    deploymentStatus = "unknown";
    healthStatus = "unknown";
  } else if (destroyCompleted && input.inventorySuccessful && !hasActiveResources) {
    deploymentStatus = "destroyed";
  } else if (destroyCompleted) {
    deploymentStatus = input.hasStoredDeploymentUrl ? "stale_live_record" : "destroyed";
    healthStatus = input.hasStoredDeploymentUrl ? "unreachable" : "not_applicable";
  } else if (
    input.deploymentActivityActive !== false &&
    (activeDeployment.has(input.storedDeploymentStatus || "") || activePipeline.has(input.pipelineStatus || ""))
  ) {
    deploymentStatus = "deploying";
    healthStatus = "unknown";
  } else if (verifiedHealthy && runtimeEvidence && input.inventorySuccessful) {
    deploymentStatus = "live";
    healthStatus = "healthy";
  } else if (verifiedUnhealthy && (runtimeEvidence || input.hasStoredDeploymentUrl) && input.inventorySuccessful) {
    deploymentStatus = "unhealthy";
    healthStatus = input.httpHealthy === false ? "unreachable" : "unhealthy";
  } else if ((input.pipelineFailedStage || "").match(/ecs|alb|stable_release|observability/i) || input.storedDeploymentStatus === "unhealthy") {
    deploymentStatus = "unhealthy";
    healthStatus = "unhealthy";
  } else if (failedDeployment.has(input.storedDeploymentStatus || "") || input.pipelineStatus === "failed") {
    deploymentStatus = "failed";
    healthStatus = "unknown";
  } else if (storedHealthy || input.hasStoredDeploymentUrl) {
    deploymentStatus = input.inventorySuccessful && !runtimeEvidence ? "stale_live_record" : "unknown";
    healthStatus = input.inventorySuccessful && !runtimeEvidence ? "unreachable" : "unknown";
  }

  let cloudVerificationStatus: CloudVerificationStatus = "verification_required";
  if (authUnavailable) cloudVerificationStatus = "auth_required";
  else if (inventoryError) cloudVerificationStatus = "verification_failed";
  else if (inventoryStale) cloudVerificationStatus = "stale";
  else if (input.inventorySuccessful) cloudVerificationStatus = "verified";

  let nextAction: CloudNextAction = "no_action";
  if (authUnavailable || input.inventoryStatus === "not_scanned" || inventoryStale || inventoryError) nextAction = "refresh_inventory";
  else if (resourceStatus === "manual_review_required") nextAction = "review_manual_resources";
  else if (input.safeLeftoverCount > 0 && resourceStatus === "cleanup_required") nextAction = "clean_safe_leftovers";
  else if (destroyCompleted && hasActiveResources) nextAction = input.terraformResourceCount > 0 ? "run_terraform_destroy" : "clean_safe_leftovers";
  else if (deploymentStatus === "unhealthy") nextAction = "view_ecs_diagnostics";
  else if (deploymentStatus === "stale_live_record" && infrastructureStatus === "provisioned") {
    nextAction = "view_ecs_diagnostics";
  }
  else if (deploymentStatus === "stale_live_record") nextAction = "verify_cloud_state";
  else if (deploymentStatus === "failed") nextAction = "retry_deployment";

  let statusExplanation = "No cloud deployment has been created for this project.";
  if (authUnavailable) statusExplanation = "Cloud inventory could not be verified because AWS authentication is required.";
  else if (inventoryError) statusExplanation = "Cloud verification failed. Stored deployment records are not being treated as live.";
  else if (inventoryStale || input.inventoryStatus === "not_scanned") statusExplanation = "Cloud inventory must be refreshed before DeployGuard can confirm the current deployment state.";
  else if (deploymentStatus === "live" && resourceStatus === "cleanup_required") statusExplanation = "Application health is verified, but leftover cloud resources require cleanup.";
  else if (deploymentStatus === "live") statusExplanation = "AWS verification confirmed healthy runtime infrastructure for this deployment.";
  else if (deploymentStatus === "destroyed" && resourceStatus === "no_cloud_resources_found") statusExplanation = "Project infrastructure was destroyed and the latest inventory found no active project resources.";
  else if (["stale_live_record", "unhealthy"].includes(deploymentStatus) && infrastructureStatus === "provisioned") statusExplanation = "Infrastructure provisioned, but app live verification failed.";
  else if (deploymentStatus === "stale_live_record") statusExplanation = "Stored deployment URL exists, but cloud verification did not confirm a live deployment.";
  else if (deploymentStatus === "unhealthy" && runtimeEvidence) statusExplanation = "Cloud resources exist, but ECS or load balancer health is not healthy.";
  else if (deploymentStatus === "unhealthy") statusExplanation = "The latest deployment failed its runtime health checks.";
  else if (destroyRunning) statusExplanation = "Terraform destroy is running. Live status is suspended until cloud inventory is verified.";
  else if (deploymentStatus === "failed") statusExplanation = "The latest deployment failed and no healthy cloud runtime was verified.";

  const adminActionRequired = ["cleanup_required", "manual_review_required", "inventory_error", "inventory_unavailable"].includes(resourceStatus) || ["destroy_failed", "unknown"].includes(infrastructureStatus) && Boolean(input.hasStoredDeploymentUrl);
  return { deploymentStatus, healthStatus, infrastructureStatus, resourceStatus, cleanupStatus, cloudVerificationStatus, inventoryStatus: input.inventoryStatus, adminActionRequired, nextAction, statusExplanation };
}
