const FRIENDLY_GITHUB_ACTIONS_STAGES: Record<string, string> = {
  set_up_job: "Prepare Source",
  checkout_exact_application_source: "Checkout Source",
  configure_aws_credentials_through_oidc: "Authenticate AWS",
  validate_immutable_release_input: "Validate Release",
  install_pinned_railpack: "Prepare Build",
  build_immutable_railpack_image: "Build Application",
  build_immutable_railpack_images: "Build Applications",
  build_and_push_immutable_railpack_image: "Build Application",
  validate_application_runtime: "Validate Application Runtime",
  publish_immutable_image_to_ecr: "Publish Image",
  publish_immutable_images_to_ecr: "Publish Images",
  workflow_dispatch: "Prepare Source",
  workflow_bootstrap: "Prepare Source",
  workflow_run_discovery: "GitHub Actions run was not created",
  github_actions: "Prepare Source",
  checkout_application: "Checkout Source",
  derive_immutable_release_identity: "Prepare Source",
  ensure_ecr_repository: "Publish Image",
  generate_dockerfile_when_absent: "Build Application",
  build_and_push_immutable_image: "Publish Image",
  install_terraform: "Deploy Runtime",
  generate_deployment_terraform: "Deploy Runtime",
  terraform_plan_and_apply: "Deploy Runtime",
  terraform_apply: "Deploy Runtime",
  materialize_release_runtime: "Deploy Runtime and Verify Application",
  publish_verified_release_result: "Finalize Release",
  release_evidence_pending: "Finalize Release",
  release_evidence_validation: "Finalize Release",
  release_finalization: "Finalize Release",
  release_complete: "Finalize Release",
  verify_exact_project_deletion: "Verify Deletion",
  project_delete_cleanup: "Finalize Cleanup",
  verify_alb_health_and_write_result: "Verify Application",
  roll_back_to_immutable_application_release: "Restore Release",
  rollback_evidence_validation: "Prepare Rollback",
  healthy: "Live",
  destroyed: "Destroyed",
};

const WORKFLOW_STEP_STAGES: Record<string, { key: string; label: string }> = {
  checkout_exact_application_source: { key: "checkout_exact_application_source", label: "Checkout Source" },
  configure_aws_credentials_through_oidc: { key: "configure_aws_credentials_through_oidc", label: "Authenticate AWS" },
  validate_immutable_release_input: { key: "validate_immutable_release_input", label: "Validate Release" },
  install_pinned_railpack: { key: "install_pinned_railpack", label: "Prepare Build" },
  build_immutable_railpack_image: { key: "build_immutable_railpack_image", label: "Build Application" },
  build_immutable_railpack_images: { key: "build_immutable_railpack_images", label: "Build Applications" },
  validate_application_runtime: { key: "validate_application_runtime", label: "Validate Application Runtime" },
  publish_immutable_image_to_ecr: { key: "publish_immutable_image_to_ecr", label: "Publish Image" },
  publish_immutable_images_to_ecr: { key: "publish_immutable_images_to_ecr", label: "Publish Images" },
  select_immutable_rollback_image: { key: "select_immutable_rollback_image", label: "Restore Release" },
  select_immutable_rollback_service_images: { key: "select_immutable_rollback_service_images", label: "Restore Release" },
  install_terraform: { key: "install_terraform", label: "Deploy Runtime" },
  materialize_release_runtime: { key: "materialize_release_runtime", label: "Deploy Runtime and Verify Application" },
  publish_verified_release_result: { key: "publish_verified_release_result", label: "Finalize Release" },
};

export type GithubActionsPresentationAction = "deploy" | "destroy" | "rollback";
const ACTION_WORKFLOW_STAGES: Record<GithubActionsPresentationAction, Set<string>> = {
  deploy: new Set(["checkout_exact_application_source", "configure_aws_credentials_through_oidc", "validate_immutable_release_input", "install_pinned_railpack", "build_immutable_railpack_images", "validate_application_runtime", "publish_immutable_images_to_ecr", "install_terraform", "materialize_release_runtime", "publish_verified_release_result"]),
  rollback: new Set(["configure_aws_credentials_through_oidc", "validate_immutable_release_input", "select_immutable_rollback_service_images", "install_terraform", "materialize_release_runtime", "publish_verified_release_result"]),
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
  "build_immutable_railpack_images",
  "build_and_push_immutable_railpack_image",
  "validate_application_runtime",
]);

export function githubActionsStagePresentation(stage: unknown, action: GithubActionsPresentationAction = "deploy") {
  const key = String(stage || "github_actions").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const label = key === "terraform_plan_and_apply" && action === "destroy"
    ? "Destroy Infrastructure"
    : FRIENDLY_GITHUB_ACTIONS_STAGES[key] || "Run Deployment";
  return { key: key || "github_actions", label };
}

export function deployguardOperationStagePresentation(stage: unknown, action: GithubActionsPresentationAction = "deploy") {
  const key = String(stage || "github_actions").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (action === "deploy") return githubActionsStagePresentation(key, action);
  if (action === "rollback") {
    if (["release_evidence_pending", "release_evidence_validation", "release_finalization", "release_complete", "publish_verified_release_result"].includes(key)) return { key, label: "Finalize Rollback" };
    if (["install_terraform", "materialize_release_runtime", "terraform_apply", "terraform_plan_and_apply"].includes(key)) return { key, label: "Update Runtime and Verify Application" };
    if (["select_immutable_rollback_image", "select_immutable_rollback_service_images", "roll_back_to_immutable_application_release"].includes(key)) return { key, label: "Restore Release" };
    return { key, label: "Prepare Rollback" };
  }
  if (["release_evidence_pending", "release_evidence_validation", "verify_exact_project_deletion", "publish_verified_release_result"].includes(key)) return { key, label: "Verify Deletion" };
  if (["project_delete_cleanup", "release_finalization", "release_complete", "destroyed"].includes(key)) return { key, label: "Finalize Cleanup" };
  if (["install_terraform", "materialize_release_runtime", "terraform_apply", "terraform_plan_and_apply"].includes(key)) return { key, label: "Destroy Infrastructure" };
  return { key, label: "Prepare" };
}

export function githubActionsFailureMessage(errorMessage: unknown, failedStage: unknown, action: GithubActionsPresentationAction = "deploy") {
  const persisted = typeof errorMessage === "string" ? errorMessage.trim() : "";
  if (persisted && persisted !== LEGACY_CANDIDATE_FAILURE) return persisted;
  if (failedStage) return `${deployguardOperationStagePresentation(failedStage, action).label} failed.`;
  return persisted || "The operation failed.";
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
  if (!presentation || action === "deploy") return presentation;
  if (action === "rollback") {
    if (["select_immutable_rollback_image", "select_immutable_rollback_service_images"].includes(key)) return { ...presentation, label: "Restore Release" };
    if (key === "install_terraform" || key === "materialize_release_runtime") return { ...presentation, label: "Update Runtime and Verify Application" };
    if (key === "publish_verified_release_result") return { ...presentation, label: "Finalize Rollback" };
    return { ...presentation, label: "Prepare Rollback" };
  }
  if (key === "install_terraform" || key === "materialize_release_runtime") return { ...presentation, label: "Destroy Infrastructure" };
  if (key === "publish_verified_release_result") return { ...presentation, label: "Verify Deletion" };
  return { ...presentation, label: "Prepare" };
}

export function githubActionsExecutionStageFromLog(log: string) {
  const matches = [...String(log || "").matchAll(/^\S+Z DEPLOYGUARD_STAGE=(terraform_plan_and_apply|terraform_apply|verify_exact_project_deletion)\s*$/gm)];
  return matches.at(-1)?.[1] || null;
}

export function githubActionsPlatformCapabilityFailure(log: string) {
  const match = /AccessDenied(?:Exception)?.{0,500}?not authorized to perform:\s*([A-Za-z0-9:*_-]+)/is.exec(String(log || ""));
  return match ? { action: match[1], classification: "platform_configuration" as const } : null;
}
