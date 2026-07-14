const USER_STAGES = [
  ["preparing_repository", "Preparing repository", /queue|validate|prepar|clone|repository|external_ci/],
  ["detecting_application", "Detecting application", /detect|snapshot/],
  ["preparing_container", "Preparing container", /template|dockerfile_generated|dockerignore/],
  ["checking_dockerfile", "Checking Dockerfile", /dockerfile_check|security_scan|security_policy|security_gate/],
  ["building_image", "Building image", /docker_build|building_image|tagging_image|ecr/],
  ["estimating_cost", "Estimating cost", /finops|cost/],
  ["preparing_cloud_resources", "Preparing cloud resources", /terraform|infrastructure|state_lock|storage|efs/],
  ["deploying_application", "Deploying application", /ecs|deploy/],
  ["checking_application_health", "Checking application health", /alb|health|stable|observability/],
  ["deployment_complete", "Deployment complete", /completed|release/],
] as const;

export function presentPipelineStage(internalStage: string) {
  const normalized = String(internalStage || "").toLowerCase();
  const match = USER_STAGES.find(([, , pattern]) => pattern.test(normalized));
  return match
    ? { key: match[0], label: match[1] }
    : { key: "preparing_repository", label: "Preparing repository" };
}
