const FRIENDLY_GITHUB_ACTIONS_STAGES: Record<string, string> = {
  set_up_job: "Setting up GitHub Actions runner",
  configure_aws_credentials_through_oidc: "Connecting securely to AWS",
  install_pinned_railpack: "Installing Railpack",
  build_immutable_railpack_image: "Building Railpack image",
  build_and_push_immutable_railpack_image: "Building Railpack image",
  publish_immutable_image_to_ecr: "Publishing immutable image",
  workflow_dispatch: "Starting GitHub Actions",
  workflow_bootstrap: "Starting GitHub Actions workflow",
  workflow_run_discovery: "GitHub Actions run was not created",
  github_actions: "Running GitHub Actions",
  checkout_application: "Checking out application source",
  derive_immutable_release_identity: "Preparing immutable release",
  ensure_ecr_repository: "Preparing image repository",
  generate_dockerfile_when_absent: "Preparing container build",
  build_and_push_immutable_image: "Building and publishing container image",
  install_terraform: "Preparing Terraform",
  generate_deployment_terraform: "Preparing infrastructure",
  terraform_plan_and_apply: "Provisioning infrastructure",
  terraform_apply: "Applying Terraform changes",
  verify_exact_project_deletion: "Verifying exact project deletion",
  project_delete_cleanup: "Finalizing project deletion",
  verify_alb_health_and_write_result: "Verifying application health",
  roll_back_to_immutable_application_release: "Restoring previous application release",
  rollback_evidence_validation: "Validating rollback evidence",
  healthy: "Live",
  destroyed: "Destroyed",
};

const WORKFLOW_STEP_STAGES: Record<string, { key: string; label: string }> = {
  checkout_exact_application_source: { key: "checkout_exact_application_source", label: "Repository checkout" },
  configure_aws_credentials_through_oidc: { key: "configure_aws_credentials_through_oidc", label: "Connecting securely to AWS" },
  validate_immutable_release_input: { key: "validate_immutable_release_input", label: "Validating immutable release" },
  install_pinned_railpack: { key: "install_pinned_railpack", label: "Installing Railpack" },
  build_immutable_railpack_image: { key: "build_immutable_railpack_image", label: "Building Railpack image" },
  publish_immutable_image_to_ecr: { key: "publish_immutable_image_to_ecr", label: "Publishing immutable image" },
  select_immutable_rollback_image: { key: "select_immutable_rollback_image", label: "Selecting immutable rollback image" },
  install_terraform: { key: "install_terraform", label: "Terraform initialization" },
  materialize_release_runtime: { key: "materialize_release_runtime", label: "Materializing runtime" },
  publish_verified_release_result: { key: "publish_verified_release_result", label: "Publishing verified release result" },
};

export type GithubActionsPresentationAction = "deploy" | "destroy" | "rollback";
const ACTION_WORKFLOW_STAGES: Record<GithubActionsPresentationAction, Set<string>> = {
  deploy: new Set(["checkout_exact_application_source", "configure_aws_credentials_through_oidc", "validate_immutable_release_input", "install_pinned_railpack", "build_immutable_railpack_image", "publish_immutable_image_to_ecr", "install_terraform", "materialize_release_runtime", "publish_verified_release_result"]),
  rollback: new Set(["configure_aws_credentials_through_oidc", "validate_immutable_release_input", "select_immutable_rollback_image", "install_terraform", "materialize_release_runtime", "publish_verified_release_result"]),
  destroy: new Set(["configure_aws_credentials_through_oidc", "validate_immutable_release_input", "install_terraform", "materialize_release_runtime", "publish_verified_release_result"]),
};
export function githubActionsWorkflowStageRelevant(stage: unknown, action: GithubActionsPresentationAction) {
  return ACTION_WORKFLOW_STAGES[action].has(String(stage || ""));
}
const LEGACY_CANDIDATE_FAILURE = "Candidate provisioning or health verification failed.";
const BUILD_PHASE_FAILURE_STAGES = new Set([
  "set_up_job",
  "checkout_application",
  "configure_aws_credentials_through_oidc",
  "derive_immutable_release_identity",
  "ensure_ecr_repository",
  "generate_dockerfile_when_absent",
  "build_and_push_immutable_image",
  "build_immutable_railpack_image",
  "build_and_push_immutable_railpack_image",
]);

export function githubActionsStagePresentation(stage: unknown, action: GithubActionsPresentationAction = "deploy") {
  const key = String(stage || "github_actions").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const label = key === "terraform_plan_and_apply" && action === "destroy"
    ? "Destroying infrastructure"
    : FRIENDLY_GITHUB_ACTIONS_STAGES[key] || "Running deployment automation";
  return { key: key || "github_actions", label };
}

export function deployguardOperationStagePresentation(stage: unknown, action: GithubActionsPresentationAction = "deploy") {
  const key = String(stage || "github_actions").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (action !== "destroy") return githubActionsStagePresentation(key, action);
  if (["release_evidence_pending", "release_evidence_validation", "verify_exact_project_deletion", "publish_verified_release_result"].includes(key)) return { key, label: "Verify deletion" };
  if (["project_delete_cleanup", "release_finalization", "release_complete", "destroyed"].includes(key)) return { key, label: "Finalize cleanup" };
  if (["install_terraform", "materialize_release_runtime", "terraform_apply", "terraform_plan_and_apply"].includes(key)) return { key, label: "Destroy infrastructure" };
  return { key, label: "Prepare" };
}

export function githubActionsFailureMessage(errorMessage: unknown, failedStage: unknown, action: GithubActionsPresentationAction = "deploy") {
  const persisted = typeof errorMessage === "string" ? errorMessage.trim() : "";
  if (persisted && persisted !== LEGACY_CANDIDATE_FAILURE) return persisted;
  if (failedStage) return `GitHub Actions failed during ${githubActionsStagePresentation(failedStage, action).label}.`;
  return persisted || "The GitHub Actions deployment failed.";
}

export function githubActionsFailureLifecyclePhase(failedStage: unknown, action: GithubActionsPresentationAction = "deploy"): "source" | "build" | "deploy" | "verify" {
  const key = githubActionsStagePresentation(failedStage).key;
  if (action === "destroy" && (key.includes("evidence") || key.includes("verify") || key === "publish_verified_release_result")) return "verify";
  if (["workflow_bootstrap", "set_up_job", "workflow_dispatch", "configure_aws_credentials_through_oidc", "checkout_exact_application_source", "validate_immutable_release_input"].includes(key)) return "source";
  if (BUILD_PHASE_FAILURE_STAGES.has(key) || key.includes("build")) return "build";
  if (key === "publish_verified_release_result") return "verify";
  if (key.includes("health") || key.includes("verify")) return "verify";
  return "deploy";
}

/**
 * Only named steps in the immutable DeployGuard reusable workflow are rendered
 * in the user-facing timeline. GitHub-generated post/cleanup steps and unknown
 * third-party steps remain available only in GitHub's own advanced run view.
 */
export function githubActionsWorkflowStepPresentation(step: unknown, action: GithubActionsPresentationAction = "deploy") {
  const key = String(step || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const presentation = ACTION_WORKFLOW_STAGES[action].has(key) ? WORKFLOW_STEP_STAGES[key] || null : null;
  return presentation;
}

export function githubActionsExecutionStageFromLog(log: string) {
  const matches = [...String(log || "").matchAll(/^\S+Z DEPLOYGUARD_STAGE=(terraform_plan_and_apply|terraform_apply|verify_exact_project_deletion)\s*$/gm)];
  return matches.at(-1)?.[1] || null;
}

export function githubActionsPlatformCapabilityFailure(log: string) {
  const match = /AccessDenied(?:Exception)?.{0,500}?not authorized to perform:\s*([A-Za-z0-9:*_-]+)/is.exec(String(log || ""));
  return match ? { action: match[1], classification: "platform_configuration" as const } : null;
}
