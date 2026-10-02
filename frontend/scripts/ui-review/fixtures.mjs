/*
 * Deterministic API fixtures for the UI review harness. Shapes follow the
 * backend contracts (project-current-state.types.ts, deploy history, billing,
 * admin and troubleshooting responses). Values are synthetic.
 */
const now = Date.now();
const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();

export const ids = {
  live: "11111111-1111-4111-8111-111111111111",
  failed: "22222222-2222-4222-8222-222222222222",
  deploying: "33333333-3333-4333-8333-333333333333",
  ready: "44444444-4444-4444-8444-444444444444",
  destroyed: "55555555-5555-4555-8555-555555555555",
  degraded: "66666666-6666-4666-8666-666666666666",
};

const sha = (seed) => `${seed}`.repeat(40).slice(0, 40);
const deployStages = (statusFor) => [
  ["checkout_exact_application_source", "Checkout exact application source", 0, 0.3],
  ["configure_aws_credentials_through_oidc", "Configure AWS credentials through OIDC", 0.3, 0.5],
  ["validate_immutable_release_input", "Validate immutable release input", 0.5, 0.7],
  ["install_pinned_railpack", "Install pinned Railpack", 0.7, 1.2],
  ["build_immutable_railpack_images", "Build immutable Railpack images", 1.2, 4.1],
  ["validate_application_runtime", "Validate application runtime", 4.1, 4.6],
  ["publish_immutable_images_to_ecr", "Publish immutable images to ECR", 4.6, 5.4],
  ["install_trivy_scanner", "Install Trivy scanner", 5.4, 5.6],
  ["scan_exact_immutable_service_images", "Scan exact immutable service images", 5.6, 6.5],
  ["install_terraform", "Install Terraform", 6.5, 6.7],
  ["materialize_release_runtime", "Materialize release runtime", 6.7, 10.9],
  ["verify_alb_health_and_write_result", "Verify ALB health and write result", 10.9, 11.6],
  ["publish_verified_release_result", "Publish verified release result", 11.6, 11.9],
].map(([key, label, start, end], index) => {
  const status = statusFor(key, index);
  return {
    key, label, status,
    startedAt: status === "pending" ? null : start,
    completedAt: ["passed", "failed"].includes(status) ? end : null,
    jobUrl: "https://github.com/acme/rentmate/actions/runs/1",
    failureReason: status === "failed" ? "npm ci exited with code 1: package-lock.json is out of sync with package.json (missing: zod@3.23.8)." : null,
  };
});
function stagesAt(startMinutesAgo, statusFor) {
  return deployStages(statusFor).map((stage) => ({
    ...stage,
    startedAt: stage.startedAt === null ? null : ago(startMinutesAgo - stage.startedAt),
    completedAt: stage.completedAt === null ? null : ago(startMinutesAgo - stage.completedAt),
  }));
}
const allPassed = () => "passed";

function services(projectId, names) {
  return names.map(([name, dir, port], index) => ({ id: `${projectId.slice(0, 8)}-svc0-4000-8000-00000000000${index}`, name, serviceDirectory: dir, servicePort: port }));
}

function project(id, name, repo, branch, extra = {}) {
  return {
    id, name, repositoryFullName: repo, repositoryUrl: `https://github.com/${repo}`, targetBranch: branch,
    environmentName: "production", description: "", visibility: "private", canManage: true,
    createdAt: ago(60 * 24 * 21), ownerUserId: 7, activity: { lastMeaningfulActivityAt: ago(40) }, ...extra,
  };
}

const rentServices = services(ids.live, [["web", "apps/web", 3000], ["api", "apps/api", 8080]]);
const checkoutServices = services(ids.degraded, [["checkout", ".", 4000]]);

export const projects = {
  [ids.live]: project(ids.live, "rentmate", "acme/rentmate", "main", { services: rentServices, applicationEntryPointServiceId: rentServices[0].id, activity: { lastMeaningfulActivityAt: ago(95) } }),
  [ids.failed]: project(ids.failed, "inventory-api", "acme/inventory-api", "develop", { services: services(ids.failed, [["api", ".", null]]), activity: { lastMeaningfulActivityAt: ago(12) } }),
  [ids.deploying]: project(ids.deploying, "portfolio-site", "hassan/portfolio-site", "main", { services: services(ids.deploying, [["web", ".", 4321]]), activity: { lastMeaningfulActivityAt: ago(3) } }),
  [ids.ready]: project(ids.ready, "analytics-worker", "acme/analytics-worker-with-a-very-long-repository-name", "feature/new-ingestion-pipeline", { services: services(ids.ready, [["worker", "services/worker", null]]), activity: { lastMeaningfulActivityAt: ago(60 * 26) } }),
  [ids.destroyed]: project(ids.destroyed, "legacy-demo", "acme/legacy-demo", "main", { services: services(ids.destroyed, [["web", ".", 3000]]), activity: { lastMeaningfulActivityAt: ago(60 * 24 * 9) } }),
  [ids.degraded]: project(ids.degraded, "checkout-service", "acme/checkout-service", "main", { services: checkoutServices, activity: { lastMeaningfulActivityAt: ago(28) } }),
};

const authority = (state, extra = {}) => ({
  state,
  reason: "",
  runtime: { state: ["LIVE"].includes(state) ? "present" : state === "DESTROYED" ? "removed" : "not_deployed", observedAt: ago(1), source: "aws_observation" },
  activeOperation: null,
  latestCompletedOperation: null,
  infrastructure: { exists: state === "LIVE", status: state === "LIVE" ? "active" : state === "DESTROYED" ? "destroyed" : "not_provisioned", source: "aws_observation", observedAt: ago(1) },
  applicationHealth: { status: state === "LIVE" ? "healthy" : "unavailable", source: "aws_observation", observedAt: ago(1) },
  monitoring: { available: state === "LIVE", status: state === "LIVE" ? "available" : "not_deployed", reason: state === "LIVE" ? "" : "Runtime monitoring starts after the first successful deployment." },
  reconciliation: { lastReconciledAt: ago(1), freshness: "current", source: "github_actions" },
  ...extra,
});

const diagnosisFailed = {
  schemaVersion: 1, operationId: "op-fail-3", deploymentAction: "deploy", sourceSha: sha("9f3c2ab"), terminalState: "failed",
  terminalFailureCode: "DG_BUILD_DEPENDENCY_INSTALL_FAILED", rootCauseCode: "NPM_LOCKFILE_OUT_OF_SYNC", failureOwner: "REPOSITORY_APPLICATION", externalProvider: null,
  failureStage: "build", serviceId: null, serviceName: "api", affectedComponent: "api — dependency install", tool: "npm", toolErrorCode: "EUSAGE",
  summary: "Dependencies could not be installed because package-lock.json does not match package.json.",
  technicalReason: "npm ci requires package.json and package-lock.json to be in sync. The lockfile is missing zod@3.23.8, which package.json declares.",
  recommendedAction: "Run npm install locally, commit the updated package-lock.json, and push a new commit.",
  remediationSteps: ["Run npm install in the repository root.", "Commit the updated package-lock.json.", "Push to develop. DeployGuard deploys the new commit."],
  retryDecision: "SAFE_AFTER_FIX", completedStages: [{ stage: "source", label: "Prepare Source" }],
  evidenceReferences: [{ source: "railpack_build", stage: "build", eventId: "ev-1", timestamp: ago(14), excerpt: "npm ERR! `npm ci` can only install packages when your package.json and package-lock.json are in sync." }],
  confidence: "DETERMINISTIC", failedAt: ago(12),
};

const diagnosisDegraded = {
  ...diagnosisFailed, operationId: "op-deg-9", sourceSha: sha("c0ffee1"), terminalFailureCode: "DG_RUNTIME_HEALTH_CHECK_FAILED", rootCauseCode: "HEALTH_CHECK_TIMEOUT",
  failureStage: "verify", serviceName: "checkout", affectedComponent: "checkout — /health", tool: "alb", toolErrorCode: null,
  summary: "The new release did not pass its health check within 5 minutes.",
  technicalReason: "GET /health returned 503 for every probe. Container logs show a missing STRIPE_WEBHOOK_SECRET at startup.",
  recommendedAction: "Add STRIPE_WEBHOOK_SECRET under Settings → Variables, then retry.",
  remediationSteps: ["Open Settings → Variables for checkout.", "Add STRIPE_WEBHOOK_SECRET.", "Retry the failed deployment."],
  retryDecision: "SAFE_NOW", completedStages: [{ stage: "source", label: "Prepare Source" }, { stage: "build", label: "Build Application" }, { stage: "publish", label: "Publish Image" }, { stage: "deploy", label: "Deploy Runtime" }],
  failedAt: ago(28),
};

const liveEvidence = (projectId, svcList, url) => ({
  source: "aws_observation", lastUpdatedAt: ago(1), freshness: "current", region: "us-east-1", executionEngine: "github_actions",
  resources: [{ type: "ECR", status: "active" }, { type: "ECS Fargate", status: "active" }, { type: "ALB", status: "active" }],
  ecr: { repository: `deployguard/${projectId.slice(0, 8)}`, imageTag: "rel-14", imageDigest: `sha256:${sha("7a1d93e4")}${sha("b2")}`.slice(0, 71) },
  ecs: { cluster: "deployguard-shared", service: `${svcList[0].name}-svc`, taskDefinitionRevision: 14, desiredCount: 1, runningCount: 1, pendingCount: 0 },
  alb: { name: "dg-shared-alb", status: "active", targetHealth: ["healthy"], endpoint: url },
  cloudWatch: { status: "active" },
  services: svcList.map((service, index) => ({ serviceId: service.id, serviceName: service.name, publicUrl: index === 0 ? url : null, imageDigest: `sha256:${sha(`${index}e4f`)}`, ecs: { service: `dg-${service.name}`, desiredCount: index ? 2 : 1, runningCount: index ? 2 : 1, pendingCount: 0 }, alb: { targetHealth: index ? ["healthy", "healthy"] : ["healthy"] } })),
  terraformState: { status: "active", storage: "encrypted_s3", key: `projects/${projectId}/gen-4/terraform.tfstate`, lastApplyAt: ago(96), lastDestroyAt: null },
  cost: { status: "estimated", currency: "USD", monthly: 47.82, source: "infracost", generationId: "gen-4", releaseId: "rel-14", operationId: "op-live-14", estimatedAt: ago(100), unavailableReason: null, breakdown: [{ name: "ECS Fargate tasks", service: "Fargate", monthly: 26.4 }, { name: "Application Load Balancer share", service: "ELB", monthly: 16.2 }, { name: "CloudWatch logs", service: "CloudWatch", monthly: 3.1 }, { name: "ECR storage", service: "ECR", monthly: 2.12 }] },
  persistentStorage: svcList.length > 1 ? { type: "EFS", status: "active", encrypted: true, backupEnabled: true, region: "us-east-1" } : null,
  runtimeIdentity: {
    albName: "dg-shared-alb", targetGroupName: `dg-${projectId.slice(0, 8)}-tg`, cloudWatchLogGroupName: `/deployguard/${projectId.slice(0, 8)}`,
    ecsClusterName: "deployguard-shared", ecsServiceName: `${svcList[0].name}-svc`, taskDefinitionArn: `arn:aws:ecs:us-east-1:123456789012:task-definition/dg-${svcList[0].name}:14`,
    imageUri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/deployguard/${projectId.slice(0, 8)}`, imageDigest: `sha256:${sha("7a1d93e4")}`,
    services: svcList.map((service, index) => ({ serviceId: service.id, serviceName: service.name, serviceDirectory: service.serviceDirectory, servicePort: service.servicePort, publicUrl: index === 0 ? url : null, imageUri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/dg/${service.name}`, imageDigest: `sha256:${sha(`${index}e4f`)}`, ecsServiceArn: `arn:aws:ecs:us-east-1:123456789012:service/deployguard-shared/dg-${service.name}`, taskDefinitionArn: `arn:aws:ecs:us-east-1:123456789012:task-definition/dg-${service.name}:14`, cloudWatchLogGroupName: `/deployguard/${service.name}` })),
  },
});

const latestAttempt = (extra) => ({ operationId: "op", generationId: "gen-4", workflowRunId: "18273645", operationType: "deploy", status: "live", outcome: "completed", attempt: "14", message: null, releaseRevision: "14", commit: sha("a41f9c2"), occurredAt: ago(95), startedAt: ago(107), completedAt: ago(95), failureOwner: null, diagnosis: null, workflowStages: [], ...extra });

export const currentStates = {
  [ids.live]: {
    stateAuthority: authority("LIVE", { latestCompletedOperation: { id: "op-live-14", type: "deploy", completedAt: ago(95), outcome: "succeeded" } }),
    developerState: "live", developerAction: "open_application", developerMessage: "", progress: { percentage: 100, phase: "finalize", label: "Live" },
    repository: "acme/rentmate", branch: "main", commit: sha("a41f9c2"),
    latestAttempt: latestAttempt({}),
    stableRelease: { id: "rel-14", operationId: "op-live-14", revision: "14", generationId: "gen-4", commit: sha("a41f9c2"), promotedAt: ago(95), verifiedAt: ago(95), rollbackAvailable: true },
    stableUrl: "https://rentmate.deployguard.app", estimatedCost: null, missingConfiguration: [], applicationError: null, canRetry: false,
    generationState: { liveGenerationId: "gen-4", candidateGenerationId: null, generations: [] },
  },
  [ids.failed]: {
    stateAuthority: authority("FAILED", { latestCompletedOperation: { id: "op-fail-3", type: "deploy", completedAt: ago(12), outcome: "failed" } }),
    developerState: "failed_application", developerAction: "none", developerMessage: "", progress: { percentage: 30, phase: "build", label: "Build failed" },
    repository: "acme/inventory-api", branch: "develop", commit: sha("9f3c2ab"),
    latestAttempt: latestAttempt({ operationId: "op-fail-3", generationId: null, status: "failed_application", outcome: null, attempt: "3", releaseRevision: null, commit: sha("9f3c2ab"), occurredAt: ago(12), startedAt: ago(16), completedAt: ago(12), failureOwner: "REPOSITORY_APPLICATION", diagnosis: diagnosisFailed, workflowStages: [{ key: "checkout_exact_application_source", status: "passed" }, { key: "build_immutable_railpack_images", status: "failed" }] }),
    stableRelease: null, stableUrl: null, estimatedCost: null, missingConfiguration: [], applicationError: { category: "build", message: diagnosisFailed.summary }, canRetry: false,
  },
  [ids.deploying]: {
    stateAuthority: authority("DEPLOYING", { activeOperation: { id: "op-dep-1", type: "deploy", status: "running", stage: "deploy", startedAt: ago(7), workflowRunId: "18274001" } }),
    developerState: "deploying", developerAction: "none", developerMessage: "", progress: { percentage: 64, phase: "deploy", label: "Starting your app" },
    repository: "hassan/portfolio-site", branch: "main", commit: sha("5be81d0"),
    latestAttempt: latestAttempt({ operationId: "op-dep-1", generationId: "gen-1", workflowRunId: "18274001", status: "deploying", outcome: null, attempt: "1", releaseRevision: null, commit: sha("5be81d0"), occurredAt: ago(7), startedAt: ago(7), completedAt: null, workflowStages: [{ key: "checkout_exact_application_source", status: "passed" }, { key: "build_immutable_railpack_images", status: "passed" }, { key: "publish_immutable_images_to_ecr", status: "passed" }, { key: "materialize_release_runtime", status: "running" }] }),
    stableRelease: null, stableUrl: null, estimatedCost: null, missingConfiguration: [], applicationError: null, canRetry: false,
  },
  [ids.ready]: {
    stateAuthority: authority("READY"), developerState: "ready", developerAction: "deploy", developerMessage: "", progress: { percentage: 0, phase: null, label: "Ready" },
    repository: projects[ids.ready].repositoryFullName, branch: projects[ids.ready].targetBranch, commit: null, latestAttempt: null, stableRelease: null, stableUrl: null, estimatedCost: null, missingConfiguration: [], applicationError: null, canRetry: false,
  },
  [ids.destroyed]: {
    stateAuthority: authority("DESTROYED", { latestCompletedOperation: { id: "op-des-6", type: "destroy", completedAt: ago(60 * 24 * 9), outcome: "destroyed" } }),
    developerState: "destroyed", developerAction: "deploy_again", developerMessage: "", progress: { percentage: 100, phase: "finalize", label: "Destroyed" },
    repository: "acme/legacy-demo", branch: "main", commit: sha("d3a1b0c"),
    latestAttempt: latestAttempt({ operationType: "destroy", status: "destroyed", outcome: "completed", attempt: "6", occurredAt: ago(60 * 24 * 9), startedAt: ago(60 * 24 * 9 + 6), completedAt: ago(60 * 24 * 9) }),
    stableRelease: null, stableUrl: null, estimatedCost: null, missingConfiguration: [], applicationError: null, canRetry: false,
  },
  [ids.degraded]: {
    stateAuthority: authority("LIVE", { latestCompletedOperation: { id: "op-deg-9", type: "deploy", completedAt: ago(28), outcome: "failed" } }),
    developerState: "live", developerAction: "open_application", developerMessage: "", progress: { percentage: 90, phase: "verify", label: "Verification failed" },
    repository: "acme/checkout-service", branch: "main", commit: sha("c0ffee1"),
    latestAttempt: latestAttempt({ operationId: "op-deg-9", status: "failed_application", outcome: null, attempt: "9", releaseRevision: null, commit: sha("c0ffee1"), occurredAt: ago(28), startedAt: ago(40), completedAt: ago(28), failureOwner: "REPOSITORY_APPLICATION", diagnosis: diagnosisDegraded, workflowStages: [{ key: "verify_alb_health_and_write_result", status: "failed" }] }),
    stableRelease: { id: "rel-8", operationId: "op-deg-8", revision: "8", generationId: "gen-3", commit: sha("b7e2d41"), promotedAt: ago(60 * 30), verifiedAt: ago(60 * 30), rollbackAvailable: true },
    stableUrl: "https://checkout.deployguard.app", estimatedCost: null, missingConfiguration: [], applicationError: null, canRetry: true,
  },
};

export function detailedState(id) {
  const state = currentStates[id];
  const project = projects[id];
  if (state.stateAuthority.state === "LIVE") return { ...state, infrastructureEvidence: liveEvidence(id, project.services, state.stableUrl) };
  return { ...state, infrastructureEvidence: { source: "unavailable", lastUpdatedAt: ago(5), freshness: "current", region: "us-east-1", executionEngine: "github_actions", resources: [], ecr: null, ecs: null, alb: null, terraformState: { status: "unavailable", storage: "unavailable", key: null, lastApplyAt: null, lastDestroyAt: null }, cost: { status: "unavailable", currency: null, monthly: null, source: "unavailable", generationId: null, releaseId: null, operationId: null, unavailableReason: "No release has been deployed." }, persistentStorage: null, runtimeIdentity: null } };
}

function op(id, attempt, status, minutesAgo, extra = {}) {
  const terminal = ["completed", "failed", "dispatch_failed"].includes(status);
  return {
    id, attempt, status, deploymentAction: "deploy", commitSha: sha("a41f9c2"), generationId: status === "completed" ? `gen-${attempt}` : null,
    createdAt: ago(minutesAgo), startedAt: ago(minutesAgo), completedAt: status === "completed" ? ago(minutesAgo - 12) : null, failedAt: status === "failed" ? ago(minutesAgo - 4) : null,
    workflowRunId: `1827${3600 + attempt}`, workflowUrl: `https://github.com/acme/repo/actions/runs/1827${3600 + attempt}`, workflowStatus: terminal ? "completed" : "in_progress",
    stageLabel: status === "completed" ? "Finalize Release" : "Build Application", workflowStages: stagesAt(minutesAgo, allPassed), aiAnalysisEligible: status === "failed", ...extra,
  };
}

export const histories = {
  [ids.live]: [op("op-live-14", 14, "completed", 107), op("op-live-13", 13, "completed", 60 * 26, { commitSha: sha("8c2e10f") }), op("op-live-12", 12, "failed", 60 * 27, { commitSha: sha("71ab3d9"), errorMessage: "Health check failed.", workflowStages: stagesAt(60 * 27, (key) => key === "verify_alb_health_and_write_result" ? "failed" : key === "publish_verified_release_result" ? "skipped" : "passed") }), op("op-live-11", 11, "completed", 60 * 50, { commitSha: sha("3f9e2c1"), deploymentAction: "rollback" })],
  [ids.failed]: [
    op("op-fail-3", 3, "failed", 16, { commitSha: sha("9f3c2ab"), stageLabel: "Build Application", failedStageLabel: "Build Application", failureCode: "DG_BUILD_DEPENDENCY_INSTALL_FAILED", failureOwner: "REPOSITORY_APPLICATION", errorMessage: diagnosisFailed.summary, diagnosis: diagnosisFailed, safeLog: "npm ERR! code EUSAGE\nnpm ERR! `npm ci` can only install packages when your package.json and package-lock.json\nnpm ERR! are in sync. Please update your lock file with `npm install` before continuing.\nnpm ERR! Missing: zod@3.23.8 from lock file", workflowStages: stagesAt(16, (key, index) => index < 4 ? "passed" : key === "build_immutable_railpack_images" ? "failed" : "skipped") }),
    op("op-fail-2", 2, "failed", 60 * 3, { commitSha: sha("9f3c2ab"), stageLabel: "Build Application", failedStageLabel: "Build Application", errorMessage: diagnosisFailed.summary, diagnosis: diagnosisFailed, workflowStages: stagesAt(60 * 3, (key, index) => index < 4 ? "passed" : key === "build_immutable_railpack_images" ? "failed" : "skipped") }),
    op("op-fail-1", 1, "dispatch_failed", 60 * 5, { commitSha: sha("9f3c2ab"), dispatchFailure: true, workflowRunId: null, workflowUrl: null, errorMessage: "GitHub App installation token expired before dispatch.", workflowStages: [] }),
  ],
  [ids.deploying]: [op("op-dep-1", 1, "running", 7, { commitSha: sha("5be81d0"), stageLabel: "Deploy Runtime", workflowStages: stagesAt(7, (key, index) => index < 10 ? "passed" : key === "materialize_release_runtime" ? "running" : "pending") })],
  [ids.ready]: [],
  [ids.destroyed]: [op("op-des-6", 6, "completed", 60 * 24 * 9, { deploymentAction: "destroy", stageLabel: "Finalize Cleanup", workflowStages: [] }), op("op-des-5", 5, "completed", 60 * 24 * 20)],
  [ids.degraded]: [
    op("op-deg-9", 9, "failed", 40, { commitSha: sha("c0ffee1"), stageLabel: "Verify Application", failedStageLabel: "Verify Application", failureCode: "DG_RUNTIME_HEALTH_CHECK_FAILED", failureOwner: "REPOSITORY_APPLICATION", errorMessage: diagnosisDegraded.summary, diagnosis: diagnosisDegraded, safeLog: "Error: STRIPE_WEBHOOK_SECRET is required\n    at loadConfig (/app/dist/config.js:14:11)", workflowStages: stagesAt(40, (key) => key === "verify_alb_health_and_write_result" ? "failed" : key === "publish_verified_release_result" ? "skipped" : "passed") }),
    op("op-deg-8", 8, "completed", 60 * 31, { commitSha: sha("b7e2d41") }),
  ],
};

const points = (base, spread, count = 30, step = 2) => Array.from({ length: count }, (_, index) => ({ timestamp: ago((count - index) * step), value: Math.max(0, base + Math.sin(index / 3) * spread + (index % 5) * spread * 0.1) }));
export const metrics = {
  availabilityState: "available",
  cpu: { points: points(18, 6) }, memory: { points: points(42, 4) }, httpLatency: { points: points(0.084, 0.02) },
  healthyHosts: { points: points(1, 0) }, unhealthyHosts: { points: points(0, 0) }, runtimeAvailability: { points: points(1, 0) },
  grafana: { configured: true, url: "http://localhost:3001" },
};

export const workspaceSummary = () => {
  const summaries = Object.values(projects).map((item) => ({ project: item, currentState: currentStates[item.id] }));
  return { summaries, needsAttention: [ids.failed, ids.degraded].map((id) => ({ project: projects[id] })) };
};

export const user = { id: 7, name: "Hassan Sajjad", email: "hassan@example.com", githubLogin: "hassan-sajjad", role: "developer", avatarUrl: null };

export const envVars = {
  variables: [
    { id: "env-1", key: "DATABASE_URL", isSecret: true, scope: "runtime", maskedValue: "••••••••", updatedAt: ago(600) },
    { id: "env-2", key: "NEXT_PUBLIC_API_URL", isSecret: false, scope: "runtime", value: "https://api.rentmate.app", updatedAt: ago(600) },
    { id: "env-3", key: "SESSION_SECRET", isSecret: true, scope: "runtime", maskedValue: "••••••••", updatedAt: ago(900) },
  ],
  managedVariables: [{ key: "PORT", destination: "runtime", source: "DeployGuard" }, { key: "HOST", destination: "runtime", source: "DeployGuard" }],
  reservedVariables: [{ key: "PORT" }, { key: "HOST" }],
};

export const notifications = {
  configurationStatus: "confirmed", provider: { configured: true },
  subscription: { destination: "hassan@example.com", confirmedAt: ago(60 * 24 * 4) },
  preference: { enabled: true, criticalEnabled: true, successEnabled: true, stageUpdatesEnabled: false },
  deliveries: [{ id: "d1", eventType: "deployment_succeeded", status: "published", metadata: { action: "deploy" }, publishedAt: ago(95) }, { id: "d2", eventType: "deployment_failed", status: "published", metadata: { action: "deploy" }, publishedAt: ago(60 * 27) }],
};

export const billing = {
  plan: "pro", planName: "Pro", status: "active", billingPeriodEnd: ago(-60 * 24 * 18), providerSubscriptionId: "sub_123", customerPortalAvailable: true,
  billing: { enabled: true, mode: "test" }, provider: { configured: true }, enforcement: { enabled: true }, pricing: { monthlyUsd: 399 },
  workspaceUsage: { currentProjects: 6, liveProjects: 2, limits: { currentProjects: 10, liveProjects: 5 }, overLimit: {} },
  invoices: [{ id: "inv_2", invoiceNumber: "DG-2026-0009", plan: "pro", paidAt: ago(60 * 24 * 12), amountDue: 39900, currency: "usd", status: "paid" }, { id: "inv_1", invoiceNumber: "DG-2026-0008", plan: "pro", paidAt: ago(60 * 24 * 42), amountDue: 39900, currency: "usd", status: "paid" }],
};

export const troubleshootingList = { items: [], provider: { provider: "gemini", available: true, availability: "available" } };
export const troubleshootingSession = {
  session: { id: "ts-0001-aaaa", pipelineRunId: "op-fail-3", providerMode: "live", updatedAt: ago(10), lastError: null },
  operation: { id: "op-fail-3", action: "deploy", commitSha: sha("9f3c2ab"), failedStage: "build", failedStageLabel: "Build Application", failedAt: ago(12), summary: diagnosisFailed.summary, diagnosis: diagnosisFailed },
  results: [{ resultMode: "live", summary: "The lockfile is stale: package.json added zod but package-lock.json was not regenerated.", technicalDetails: "The build ran `npm ci`, which refuses to modify the lockfile. Commit 9f3c2ab added zod@3.23.8 to package.json without updating package-lock.json.", rootCause: "package-lock.json out of sync with package.json.", remediationSteps: ["Run `npm install` locally.", "Commit package-lock.json.", "Push to develop."], confidence: 0.94, limitations: "Based on the build log excerpt only.", evidenceReferences: [{ source: "railpack_build", stage: "build", eventId: "ev-1" }], diagnosticDetails: { likelyResponsibility: "REPOSITORY_APPLICATION", affectedComponent: "api — dependency install", recommendedAction: "Regenerate and commit the lockfile.", retryRecommendation: { decision: "SAFE_AFTER_FIX", reason: "Retrying the same commit will fail again." }, completedStages: [{ stage: "source" }] } }],
  evidence: { groups: { railpack_build: [{ eventId: "ev-1", stage: "build", timestamp: ago(14), text: "npm ERR! code EUSAGE\nnpm ERR! `npm ci` can only install packages when your package.json and package-lock.json are in sync." }], github_actions_stage: [{ eventId: "ev-2", stage: "build", timestamp: ago(13), text: "Build immutable Railpack images: failure" }] }, context: {} },
  messages: [],
  suggestedQuestions: [{ type: "explain_fix", label: "How do I fix this?" }, { type: "retry_safe", label: "Is it safe to retry?" }],
};

export const admin = {
  overview: { generatedAt: ago(1), counts: { projects: 6, activeOperations: 1, destroyingOperations: 0, failedOperations: 2 }, services: { backend: { status: "available", source: "live_api" }, database: { status: "available", source: "postgresql_probe" }, githubOAuth: { status: "configured", source: "runtime_configuration" }, githubApp: { status: "configured", source: "runtime_configuration" }, githubActions: { status: "available", source: "live_api" }, awsOidc: { status: "configured", source: "runtime_configuration" }, terraformState: { status: "available", source: "live_api" }, prometheus: { status: "degraded", source: "live_api" }, grafana: { status: "disabled", source: "runtime_configuration" } } },
  users: { users: [{ id: 7, name: "Hassan Sajjad", email: "hassan@example.com", githubLogin: "hassan-sajjad", role: "developer", enabled: true, lastLoginAt: ago(20) }, { id: 8, name: "Faria Fatima", email: "faria@example.com", githubLogin: "faria-f", role: "developer", enabled: true, lastLoginAt: ago(60 * 5) }, { id: 9, name: "Tania Khawar", email: "tania@example.com", githubLogin: "tania-k", role: "readonly", enabled: true, lastLoginAt: ago(60 * 48) }, { id: 10, name: null, email: "contractor@example.com", githubLogin: null, role: "readonly", enabled: false, lastLoginAt: null }] },
  audit: { logs: [{ id: "a1", createdAt: ago(12), actorEmail: "hassan@example.com", actorRole: "developer", action: "DEPLOYMENT_FAILED", resourceType: "project", resourceId: ids.failed, status: "failed", metadata: { operationId: "op-fail-3", failureCode: "DG_BUILD_DEPENDENCY_INSTALL_FAILED" } }, { id: "a2", createdAt: ago(95), actorEmail: "hassan@example.com", actorRole: "developer", action: "DEPLOYMENT_SUCCEEDED", resourceType: "project", resourceId: ids.live, status: "success", metadata: { release: "14" } }, { id: "a3", createdAt: ago(300), actorEmail: "admin@deployguard.dev", actorRole: "admin", action: "USER_ROLE_UPDATED", resourceType: "user", resourceId: "9", status: "success", metadata: { from: "developer", to: "readonly" } }], pagination: { page: 1, limit: 20, total: 3, totalPages: 1 } },
};
admin.projects = { summaries: workspaceSummary().summaries };

export const cleanup = {
  summary: { summary: { region: "us-east-1", cleanupRequiredProjects: 1, highCostRiskResources: 2, manualReviewResources: 3, inventoryErrors: 0, safeOrphanResources: 4 }, latestScan: { status: "completed", servicesChecked: ["ecs", "elbv2", "ecr", "logs", "secretsmanager", "efs"], resourceCount: 38, completedAt: ago(30), errors: [] }, cleanupOperations: [{ kind: "project_destroy", id: "c1", status: "completed", cleanupStatus: "verified" }], projects: [{ id: ids.destroyed, name: "legacy-demo", repositoryFullName: "acme/legacy-demo", deploymentStatus: "destroyed", cloudVerificationStatus: "verified", healthStatus: "not_running", infrastructureStatus: "destroyed", resourceStatus: "residue_found", resourceCount: 4, highCostCount: 0, cleanupStatus: "cleanup_required", manualReviewCount: 1, nextAction: "clean_safe_residue", statusExplanation: "4 tagged resources remain after destroy.", latestDestroy: { id: "op-des-6", status: "completed" }, canMarkCleanupComplete: false }, { id: ids.live, name: "rentmate", repositoryFullName: "acme/rentmate", deploymentStatus: "live", cloudVerificationStatus: "verified", healthStatus: "healthy", infrastructureStatus: "active", resourceStatus: "owned", resourceCount: 21, highCostCount: 2, cleanupStatus: "not_required", manualReviewCount: 0, nextAction: "none", statusExplanation: "Owned by a live project.", latestDestroy: null, canMarkCleanupComplete: false }] },
  resources: { resources: [{ id: "r1", name: "dg-legacy-demo-logs", type: "log_group", awsService: "CloudWatch Logs", region: "us-east-1", projectId: ids.destroyed, projectName: "legacy-demo", pipelineRunId: "op-des-6", ownership: "deployguard_tagged", cleanupEligibility: "safe", status: "orphan", costRisk: "low", firstSeen: ago(60 * 24 * 20), lastSeen: ago(30), safeToCleanup: true, protected: false, reason: "Project destroyed; log group retained." }, { id: "r2", name: "dg-legacy-demo-efs", type: "efs_file_system", awsService: "EFS", region: "us-east-1", projectId: ids.destroyed, projectName: "legacy-demo", ownership: "deployguard_tagged", cleanupEligibility: "manual", status: "manual_review", costRisk: "high", firstSeen: ago(60 * 24 * 20), lastSeen: ago(30), safeToCleanup: false, protected: false, reason: "May contain persistent data." }], groups: [{ projectId: ids.destroyed, projectName: "legacy-demo", terraformStack: [], directCleanup: { ecrRepositories: [{ id: "g1", name: "deployguard/legacy-demo", children: [{}, {}] }], logs: [{ id: "g2", name: "/deployguard/legacy-demo" }], secrets: [], oldTaskDefinitions: [{ id: "g3", name: "dg-legacy-web:5" }] }, manualReview: [{ id: "g4", name: "dg-legacy-demo-efs" }], protected: [] }] },
  emergency: { targetCount: 2, resourceCount: 17 },
};
