const FRIENDLY_GITHUB_ACTIONS_STAGES: Record<string, string> = {
  configure_aws_credentials_through_oidc: "Connecting securely to AWS",
  workflow_dispatch: "Starting GitHub Actions",
  github_actions: "Running GitHub Actions",
  checkout_application: "Checking out application source",
  derive_immutable_release_identity: "Preparing immutable release",
  ensure_ecr_repository: "Preparing image repository",
  generate_dockerfile_when_absent: "Preparing container build",
  build_and_push_immutable_image: "Building and publishing container image",
  install_terraform: "Preparing Terraform",
  generate_deployment_terraform: "Preparing infrastructure",
  terraform_plan_and_apply: "Provisioning infrastructure",
  verify_alb_health_and_write_result: "Verifying application health",
  healthy: "Live",
  destroyed: "Destroyed",
};

export function githubActionsStagePresentation(stage: unknown) {
  const key = String(stage || "github_actions").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return { key: key || "github_actions", label: FRIENDLY_GITHUB_ACTIONS_STAGES[key] || "Running deployment automation" };
}
