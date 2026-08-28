const FRIENDLY_GITHUB_ACTIONS_STAGES: Record<string, string> = {
  set_up_job: "Setting up GitHub Actions runner",
  configure_aws_credentials_through_oidc: "Connecting securely to AWS",
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
  checkout_application: { key: "checkout_application", label: "Repository checkout" },
  configure_aws_credentials_through_oidc: { key: "configure_aws_credentials_through_oidc", label: "Connecting securely to AWS" },
  derive_immutable_release_identity: { key: "derive_immutable_release_identity", label: "Preparing immutable release" },
  ensure_ecr_repository: { key: "ensure_ecr_repository", label: "Preparing image repository" },
  generate_dockerfile_when_absent: { key: "generate_dockerfile_when_absent", label: "Dockerfile preparation" },
  build_and_push_immutable_image: { key: "build_and_push_immutable_image", label: "Docker image build and ECR publication" },
  install_terraform: { key: "install_terraform", label: "Terraform initialization" },
  generate_deployment_terraform: { key: "generate_deployment_terraform", label: "Preparing deployment Terraform" },
  terraform_plan_and_apply: { key: "terraform_plan_and_apply", label: "Terraform plan and apply" },
  terraform_apply: { key: "terraform_apply", label: "Terraform apply" },
  destroy_other_recorded_generations_exactly: { key: "destroy_other_recorded_generations_exactly", label: "Cleaning recorded generations" },
  destroy_project_scoped_persistence: { key: "destroy_project_scoped_persistence", label: "Deleting project persistence" },
  delete_exact_project_owned_runtime_artifacts: { key: "delete_exact_project_owned_runtime_artifacts", label: "Deleting project runtime artifacts" },
  verify_alb_health_and_write_result: { key: "verify_alb_health_and_write_result", label: "ALB health verification" },
  verify_exact_project_deletion_and_write_result: { key: "verify_exact_project_deletion", label: "Verifying exact project deletion" },
  upload_deployguard_result: { key: "upload_deployguard_result", label: "Uploading deployment result" },
};

export type GithubActionsPresentationAction = "deploy" | "destroy" | "rollback";
const LEGACY_CANDIDATE_FAILURE = "Candidate provisioning or health verification failed.";
const BUILD_PHASE_FAILURE_STAGES = new Set([
  "set_up_job",
  "checkout_application",
  "configure_aws_credentials_through_oidc",
  "derive_immutable_release_identity",
  "ensure_ecr_repository",
  "generate_dockerfile_when_absent",
  "build_and_push_immutable_image",
]);

export function githubActionsStagePresentation(stage: unknown, action: GithubActionsPresentationAction = "deploy") {
  const key = String(stage || "github_actions").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const label = key === "terraform_plan_and_apply" && action === "destroy"
    ? "Destroying infrastructure"
    : FRIENDLY_GITHUB_ACTIONS_STAGES[key] || "Running deployment automation";
  return { key: key || "github_actions", label };
}

export function githubActionsFailureMessage(errorMessage: unknown, failedStage: unknown, action: GithubActionsPresentationAction = "deploy") {
  const persisted = typeof errorMessage === "string" ? errorMessage.trim() : "";
  if (persisted && persisted !== LEGACY_CANDIDATE_FAILURE) return persisted;
  if (failedStage) return `GitHub Actions failed during ${githubActionsStagePresentation(failedStage, action).label}.`;
  return persisted || "The GitHub Actions deployment failed.";
}

export function githubActionsFailureLifecyclePhase(failedStage: unknown): "source" | "build" | "deploy" | "verify" {
  const key = githubActionsStagePresentation(failedStage).key;
  if (["workflow_bootstrap", "set_up_job", "workflow_dispatch", "configure_aws_credentials_through_oidc"].includes(key)) return "source";
  if (BUILD_PHASE_FAILURE_STAGES.has(key) || key.includes("build")) return "build";
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
  const presentation = WORKFLOW_STEP_STAGES[key] || null;
  return presentation && key === "terraform_plan_and_apply" && action === "destroy"
    ? { ...presentation, label: "Terraform destroy plan and apply" }
    : presentation;
}

export function githubActionsExecutionStageFromLog(log: string) {
  const matches = [...String(log || "").matchAll(/^\S+Z DEPLOYGUARD_STAGE=(terraform_plan_and_apply|terraform_apply|verify_exact_project_deletion)\s*$/gm)];
  return matches.at(-1)?.[1] || null;
}

export function githubActionsPlatformCapabilityFailure(log: string) {
  const match = /AccessDenied(?:Exception)?.{0,500}?not authorized to perform:\s*([A-Za-z0-9:*_-]+)/is.exec(String(log || ""));
  return match ? { action: match[1], classification: "platform_configuration" as const } : null;
}
