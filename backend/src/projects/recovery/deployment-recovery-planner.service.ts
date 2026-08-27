import { Injectable } from "@nestjs/common";
import { normalizePipelineFailureClass } from "../pipeline/pipeline-stage-presenter";
import { ProjectCostEstimate } from "../../finops/project-cost-estimate.entity";
import { AuthoritativeProjectCloudState } from "../../infrastructure-lifecycle/cloud-state-reconciliation.service";
import { ProjectInfrastructureEnvironment } from "../../infrastructure/project-infrastructure-environment.entity";
import { ProjectDeployment } from "../../orchestration/project-deployment.entity";
import { ProjectPersistentStorage } from "../../storage/project-persistent-storage.entity";
import { ProjectDatabaseTier } from "../project-database-tier.entity";
import { ProjectServiceBinding } from "../project-service-binding.entity";
import { ProjectDeploymentContract } from "../project-deployment-contract.entity";
import { ProjectPipelineEvent } from "../project-pipeline-event.entity";
import { ProjectPipelineRun } from "../project-pipeline-run.entity";
import { ProjectPreflightReport } from "../project-preflight-report.entity";
import { ProjectTerraformLock } from "../../state-management/project-terraform-lock.entity";
import { TerraformStateSafetySnapshot } from "../../state-management/terraform-state-safety-snapshot.service";
import { DeploymentCheckpointService } from "./deployment-checkpoint.service";
import { DatabaseRequirementAnalyzer } from "./database-requirement-analyzer.service";
import { EcsDiagnosticsClassifier } from "./ecs-diagnostics-classifier.service";
import { PreflightIssueMapper } from "./preflight-issue-mapper.service";
import { RecoveryCategory, RecoveryEvidence, RecoveryIssue, RecoverySeverity } from "./recovery-issue.types";
import { StorageRequirementAnalyzer } from "./storage-requirement-analyzer.service";

type PlannerInput = {
  projectId: string;
  repositoryFullName: string | null;
  branch: string | null;
  contract: ProjectDeploymentContract | null;
  preflight: ProjectPreflightReport | null;
  run: ProjectPipelineRun | null;
  events: ProjectPipelineEvent[];
  cost: ProjectCostEstimate | null;
  environment: ProjectInfrastructureEnvironment | null;
  lock: ProjectTerraformLock | null;
  storage: ProjectPersistentStorage | null;
  deployment: ProjectDeployment | null;
  databaseTier: ProjectDatabaseTier | null;
  databaseServiceBinding?: ProjectServiceBinding | null;
  cloudState: AuthoritativeProjectCloudState;
  isDeploymentJobActive: boolean;
  stateSafety: TerraformStateSafetySnapshot;
};

type Candidate = Omit<RecoveryIssue, "primaryActionRoute" | "resumeFromStage" | "canResume" | "requiresFullRerun" | "affectedStages" | "safeToRetry" | "developerDetails"> & {
  priority: number;
  route: (projectId: string) => string;
  developerDetails?: Record<string, unknown>;
};

@Injectable()
export class DeploymentRecoveryPlanner {
  constructor(
    private readonly checkpoints: DeploymentCheckpointService,
    private readonly preflightIssues: PreflightIssueMapper,
    private readonly ecsDiagnostics: EcsDiagnosticsClassifier,
    private readonly databaseRequirements: DatabaseRequirementAnalyzer,
    private readonly storageRequirements: StorageRequirementAnalyzer,
  ) {}

  plan(input: PlannerInput): RecoveryIssue | null {
    const candidates = this.candidates(input).sort((left, right) => left.priority - right.priority);
    const selected = candidates[0];
    if (!selected) return null;
    const { priority: _priority, route, developerDetails, ...issue } = selected;
    const resume = this.checkpoints.plan(issue.code);
    return {
      ...issue,
      primaryActionRoute: route(input.projectId),
      ...resume,
      developerDetails: {
        pipelineRunId: input.run?.id || null,
        failedStage: input.run?.currentStage || null,
        latestRunStatus: input.run?.status || null,
        isDeploymentJobActive: input.isDeploymentJobActive,
        deploymentId: input.deployment?.id || null,
        checkpointFingerprints: this.checkpoints.fingerprints(input.contract, input.run),
        ...developerDetails,
      },
    };
  }

  private candidates(input: PlannerInput): Candidate[] {
    const results: Candidate[] = [];
    const diagnostics = this.ecsDiagnostics.diagnostics(input.deployment, input.events);
    const stateEvidenceCutoff = input.stateSafety.supersedesHistoricalFailuresAt
      ? new Date(input.stateSafety.supersedesHistoricalFailuresAt).getTime()
      : 0;
    const isStateFailure = (value: unknown) => /state lock|lock heartbeat|state corrupt|state recovery|terraform state/i.test(String(value || ""));
    const eventMessages = input.events
      .filter((event) => {
        const occurredAt = event.occurredAt || event.createdAt;
        return !(stateEvidenceCutoff && isStateFailure(event.message) && occurredAt && new Date(occurredAt).getTime() <= stateEvidenceCutoff);
      })
      .filter((event) => ["failed", "blocked", "error"].includes(event.status))
      .map((event) => event.message);
    const runError = stateEvidenceCutoff && isStateFailure(input.run?.errorMessage) && input.run?.updatedAt && new Date(input.run.updatedAt).getTime() <= stateEvidenceCutoff
      ? null
      : input.run?.errorMessage;
    const combined = [
      runError, input.deployment?.errorMessage,
      ...(input.contract?.blockers || []), ...(input.preflight?.errors || []),
      ...eventMessages,
      input.cost?.errorMessage, input.databaseTier?.lastError, input.storage?.errorMessage,
      diagnostics?.summary, ...(diagnostics?.logLines || []), ...(diagnostics?.taskEvents || []),
    ].filter(Boolean).join("\n");
    const currentRunReachedHealthVerification = !input.run ||
      /alb_health|health_check|stable_release/.test(String(input.run.currentStage || "")) ||
      input.events.some((event) => /alb_health|health_check|stable_release/.test(String(event.stage || "")));
    const cloudHealthBelongsToCurrentRun = Boolean(
      !input.run ||
      (
        input.deployment?.pipelineRunId === input.run.id &&
        input.cloudState.evidence?.storedDeploymentId === input.deployment.id
      )
    );

    if (/authentication required|session expired|sign in again|recent authentication required|admin required/i.test(combined)) {
      const github = /github.*(?:reauth|authentication)|token.*expired/i.test(combined);
      const recent = /recent authentication/i.test(combined);
      const admin = /admin required/i.test(combined);
      const code = github ? "github_reauth_required" : recent ? "recent_auth_required" : admin ? "admin_required" : "authentication_required";
      results.push(this.issue(1, code, "Sign in again to continue", "critical", "auth", this.line(combined, /authentication|session|sign in|token|admin/i), "Your identity must be confirmed before DeployGuard can continue this action.", [{ source: github ? "github" : "settings", message: this.line(combined, /authentication|session|sign in|token|admin/i) }], github ? "Reconnect GitHub access, then retry the failed source operation." : "Sign in again, then return to this recovery action.", github ? "Reconnect GitHub" : "Sign in again", () => github ? "/auth/github" : "/login", "external", github ? "github_auth" : "authentication"));
    }
    if (input.cloudState.inventoryStatus === "unavailable_auth_required") {
      results.push(this.issue(1, "aws_permission_reauth_required", "Cloud access needs attention", "critical", "auth", "DeployGuard could not authenticate while verifying this project's cloud resources.", "Cloud resource status cannot be trusted until AWS access is restored.", [{ source: "settings", message: "Cloud inventory authentication failed." }], "Restore the configured AWS credentials, then refresh cloud inventory.", "Review cloud access", () => "/login", "external", "cloud_auth"));
    }
    if (!input.repositoryFullName) {
      results.push(this.issue(2, "github_repo_missing", "Connect a repository", "blocker", "source", "No GitHub repository is connected to this project.", "DeployGuard needs a source repository before it can analyze or deploy the app.", [{ source: "github", message: "Repository full name is missing." }], "Connect a GitHub repository and choose a branch.", "Connect repository", (id) => `/projects/${id}/settings?recovery=github_repo_missing&focus=repository_source`, "focused_settings", "repository_source"));
    } else if (/repository not found|authentication failed|could not read from remote|permission denied|branch .* not found|remote branch|github token.*expired/i.test(combined)) {
      const branch = /branch .* not found|remote branch/i.test(combined);
      const tokenExpired = /github token.*expired|token expired/i.test(combined);
      const code = branch ? "branch_not_found" : tokenExpired ? "github_token_expired" : "repo_private_access_failed";
      results.push(this.issue(2, code, branch ? "Deployment branch not found" : tokenExpired ? "GitHub access expired" : "Repository access failed", "blocker", "source", this.line(combined, /repository|authentication|permission|branch|token/i), branch ? "The selected branch is unavailable." : "DeployGuard cannot read the selected repository with the current GitHub access.", [{ source: "github", message: this.line(combined, /repository|authentication|permission|branch|token/i) }], branch ? "Choose an existing deployment branch." : "Reconnect GitHub access for this repository.", branch ? "Choose branch" : "Reconnect GitHub", (id) => `/projects/${id}/settings?recovery=${code}&focus=repository_source`, "focused_settings", "repository_source"));
    }

    const rawFailureClass = (input.run?.metadata as Record<string, unknown> | null)?.failureClass;
    const failureClass = normalizePipelineFailureClass(rawFailureClass, input.run?.currentStage, combined) || "";
    if (
      ["contract_invalid", "plan_policy_failed"].includes(failureClass)
      || /Deployment contract is invalid before infrastructure planning|Terraform plan task-definition policy failed/i.test(combined)
    ) {
      const policyFailure = failureClass === "plan_policy_failed" || /plan task-definition policy/i.test(combined);
      results.push(this.issue(
        3,
        policyFailure ? "plan_policy_failed" : "contract_invalid",
        policyFailure ? "Deployment configuration needs a corrected plan" : "Deployment configuration needs attention",
        "blocker",
        "runtime",
        policyFailure ? "The rendered application task definition did not match the approved deployment contract." : "The application deployment contract failed semantic validation before infrastructure planning.",
        "DeployGuard stopped before changing cloud resources.",
        [{ source: "preflight", message: policyFailure ? "Rendered task-definition policy failed." : "Pre-mutation contract validation failed." }],
        policyFailure ? "Repair the protected mapping, generate a new plan, and request fresh approval." : "Repair the unresolved application configuration and revalidate the contract.",
        policyFailure ? "Generate corrected plan" : "Fix deployment setup",
        (id) => `/projects/${id}/recovery`,
        "recovery_center",
        policyFailure ? "infrastructure_recovery" : "deployment_requirements",
        { failureClass: policyFailure ? "plan_policy_failed" : "contract_invalid", infrastructureMutationStarted: false },
      ));
    }

    if (
      failureClass === "managed_database_binding_invalid"
      || /does not use the binding secret reference|could not safely map the managed database binding/i.test(combined)
    ) {
      results.push(this.issue(
        3,
        "managed_database_binding_invalid",
        "Configure application database",
        "blocker",
        "database",
        "Protected managed database values were not rendered through the binding's ECS secret references.",
        "DeployGuard is preserving the existing infrastructure and will repair only the application database mapping.",
        [{ source: "ecs", message: "Application task-definition binding validation failed; secret values were withheld." }],
        "Reuse the valid image and managed database binding, generate a corrected task-definition plan, and request fresh approval.",
        "Resume database binding",
        (id) => `/projects/${id}/recovery`,
        "recovery_center",
        "database_setup",
        { failureClass: "managed_database_binding_invalid", preserveInfrastructure: true },
      ));
    }

    if (failureClass === "managed_service_not_ready") {
      results.push(this.issue(
        3,
        "managed_service_not_ready",
        "Managed service is not ready",
        "blocker",
        "database",
        "The managed database, service registration, private connectivity, or persistent storage is not ready.",
        "DeployGuard stopped before treating the application as healthy.",
        [{ source: "database", message: this.line(combined, /database|cloud map|private|efs|readiness|healthy/i) }],
        "Resume managed-service readiness checks, then redeploy the application task and verify health.",
        "Retry managed service",
        (id) => `/projects/${id}/recovery`,
        "recovery_center",
        "database_setup",
        { failureClass, legacyFailureCode: String((input.run?.metadata as Record<string, unknown> | null)?.legacyFailureCode || "database_service_unhealthy") },
      ));
    }

    const currentRunApplyMutationStarted = input.events.some((event) =>
      ["terraform_apply_started", "infrastructure_apply_started"].includes(
        String(event.stage || "").toLowerCase(),
      )
      && ["running", "success", "passed", "completed"].includes(
        String(event.status || "").toLowerCase(),
      ),
    );
    const immutableConfigurationChanged = Boolean(
      input.run &&
      !currentRunApplyMutationStarted &&
      (
        failureClass === "configuration_changed"
        || /configuration changed|deployment contract changed|stale configuration|plan (?:expired|stale)/i.test(
          input.run.errorMessage || combined,
        )
      )
    );
    if (immutableConfigurationChanged) {
      results.push(this.issue(
        3,
        "project_configuration_changed",
        "Configuration changed",
        "blocker",
        "terraform",
        "Project configuration changed after this immutable deployment run was queued.",
        "This run stopped before Terraform apply. Existing project infrastructure was not created or modified by it.",
        [{ source: "terraform", message: "The saved Terraform plan no longer matches the current project configuration." }],
        "Create a new immutable run and generate a fresh Terraform plan. Valid repository, build, and ECR checkpoints may be reused.",
        "Generate a new Terraform plan",
        (id) => `/projects/${id}/recovery`,
        "recovery_center",
        "infrastructure_recovery",
        { cleanupRequiredForCurrentRun: false, currentRunCreatedResources: false, currentRunModifiedResources: false },
      ));
    }

    const preflightSignals = this.preflightIssues.map(input.contract, input.preflight);
    for (const signal of preflightSignals) {
      if (signal.kind === "environment") {
        results.push(this.issue(4, signal.code, "Configuration values required", "blocker", "runtime", signal.message, "Your app needs these configuration values before it can start.", [{ source: "preflight", message: signal.missingKeys.join(", ") || signal.message }], "Complete the unresolved deployment requirements. Saved secret values remain masked.", "Add required variables", (id) => `/projects/${id}/requirements?focus=secrets`, "focused_settings", "missing_environment_variables"));
      } else {
        results.push(this.issue(3, signal.code, "Repository setup needs attention", "blocker", "source", signal.message, "DeployGuard could not prove which application or runtime should be deployed.", [{ source: "preflight", message: signal.message }], "Correct the detected application path or runtime command, then re-run analysis.", "Fix repository analysis", (id) => `/projects/${id}/settings?recovery=${signal.code}&focus=detection_override`, "focused_settings", "detection_override"));
      }
    }
    if (!preflightSignals.length && String(input.contract?.confidence || "").toLowerCase() === "low") {
      results.push(this.issue(3, "low_confidence_detection", "Confirm application setup", "warning", "source", "Repository analysis completed with low confidence.", "DeployGuard needs you to confirm the application path and runtime commands before deployment.", [{ source: "preflight", message: "Stack detection confidence is low." }], "Confirm the detected application directory and commands.", "Review detection", (id) => `/projects/${id}/settings?recovery=low_confidence_detection&focus=detection_override`, "focused_settings", "detection_override"));
    }

    const databaseLocalhostEvidence = this.ecsDiagnostics.isLocalhostDatabaseFailure(combined);
    const bindingSupersedesLocalhost = Boolean(
      input.databaseServiceBinding &&
      !/^(localhost|127\.|0\.0\.0\.0|::1)/i.test(input.databaseServiceBinding.hostReference) &&
      ["applied", "ready", "verified"].includes(input.databaseServiceBinding.status)
    );
    const databaseLocalhost = databaseLocalhostEvidence && !bindingSupersedesLocalhost;
    if (databaseLocalhostEvidence && bindingSupersedesLocalhost) {
      results.push(this.issue(3, "database_binding_not_verified", "Database binding verification required", "blocker", "database", "Historical localhost diagnostics do not match the managed binding rendered into this run's task definition.", "The managed database values were generated, but this run needs binding reconciliation and fresh task-specific diagnostics before application health can be trusted.", [{ source: "ecs", message: `Run binding ${input.databaseServiceBinding!.id} owns the private database host; older localhost evidence is superseded.` }], "Resume database binding reconciliation, verify PostgreSQL readiness, then redeploy the existing image.", "Resume database binding", (id) => `/projects/${id}/recovery`, "recovery_center", "database_setup", { bindingId: input.databaseServiceBinding!.id, bindingStatus: input.databaseServiceBinding!.status }));
    } else if (databaseLocalhost) {
      const line = this.line(combined, /ECONNREFUSED|connection refused|database at localhost|localhost is the application container/i);
      results.push(this.issue(3, "app_connected_to_localhost_database", "Database setup required", "critical", "database", "The app is trying to connect to PostgreSQL at 127.0.0.1:5432 inside the app container.", "In cloud deployment, localhost means inside the app container, not the database service.", [{ source: diagnostics?.logLines?.length ? "cloudwatch" : "ecs", message: line, timestamp: input.deployment?.failedAt?.toISOString() }], "Configure a DeployGuard-managed database container with EFS or provide an external database endpoint.", "Configure database", (id) => `/projects/${id}/requirements?focus=database`, "focused_settings", "database_setup", { diagnosticCode: diagnostics?.diagnosticCode || "DATABASE_LOCALHOST_UNREACHABLE", containerExitCode: diagnostics?.containerExitCode ?? null }));
    } else {
      const database = this.databaseRequirements.analyze(input.contract, input.databaseTier, combined);
      if (database) {
        const setupRequired = ["database_required_but_not_configured", "database_localhost_config"].includes(database.code);
        results.push(this.issue(5, database.code, "Database setup required", "blocker", "database", database.message, setupRequired ? "Your application needs a private managed database or a reachable external endpoint." : "The application database is configured, but it is not ready for a healthy application connection.", [{ source: "database", message: database.message }], setupRequired ? "Choose a managed database or enter an external database endpoint." : "Review only the database connection and service settings.", setupRequired ? "Complete database requirements" : "Fix database", (id) => `/projects/${id}/requirements?focus=database`, "focused_settings", "database_setup"));
      }
    }

    const storage = this.storageRequirements.analyze(input.contract, input.storage, combined);
    if (storage) {
      const confirmation = storage.code === "persistent_data_delete_confirmation_required";
      const missing = storage.code === "file_storage_required_but_not_configured";
      results.push(this.issue(confirmation ? 12 : 5, storage.code, confirmation ? "Persistent data confirmation required" : missing ? "Persistent storage setup required" : "Persistent storage needs attention", confirmation ? "warning" : "blocker", "storage", storage.message, confirmation ? "DeployGuard will not delete persistent project data without explicit confirmation." : missing ? "Files written by the app would be lost when its container restarts." : "The application cannot use its configured persistent file storage.", [{ source: missing ? "preflight" : "efs", message: storage.message }], confirmation ? "Review the protected persistent data and confirm the intended cleanup action." : missing ? "Configure project-scoped application storage." : "Review only the project storage mount and permissions.", confirmation ? "Review persistent data" : missing ? "Configure storage" : "Fix storage", (id) => `/projects/${id}/storage?recovery=${storage.code}`, "recovery_center", "storage_setup"));
    }

    if (/docker build|npm (?:ci|install)|yarn install|pnpm install|module not found|cannot find module|dockerfile|production dependency|npm script|image too large|native dependency/i.test(combined) && !/unsafe dockerfile|privileged container/i.test(combined)) {
      const code = /dockerfile.*(?:generate|generation).*failed/i.test(combined) ? "dockerfile_generation_failed" : /module not found|cannot find module/i.test(combined) ? "module_not_found" : /production dependency/i.test(combined) ? "missing_production_dependency" : /npm script/i.test(combined) ? "npm_script_missing" : /image too large/i.test(combined) ? "image_too_large" : /native dependency/i.test(combined) ? "unsupported_native_dependency" : /npm|yarn|pnpm/i.test(combined) ? "dependency_install_failed" : "docker_build_failed";
      results.push(this.issue(6, code, "Image build failed", "blocker", "build", this.line(combined, /docker|npm|yarn|pnpm|module/i), "DeployGuard could not build a runnable application image.", [{ source: "docker", message: this.line(combined, /docker|npm|yarn|pnpm|module/i) }], "Review the failed build command and meaningful log line.", "Open build fix", (id) => `/projects/${id}/pipeline?recovery=${code}`, "recovery_center", "build_fix"));
    }

    if (/CannotPullContainerError|pull image|\bECR\b|image manifest|no basic auth credentials|image tag missing/i.test(combined)) {
      const code = /\bECR\b.*push.*failed|push.*\bECR\b.*failed/i.test(combined) ? "ecr_push_failed" : /auth|credentials/i.test(combined) ? "ecr_auth_failed" : /tag missing/i.test(combined) ? "image_tag_missing" : /not found|manifest/i.test(combined) ? "image_not_found" : "image_pull_failed";
      results.push(this.issue(8, code, "Container image unavailable", "blocker", "runtime", this.line(combined, /pull image|\bECR\b|manifest|auth|credentials/i), "ECS could not retrieve the application image.", [{ source: "ecs", message: this.line(combined, /pull image|\bECR\b|manifest|auth|credentials/i) }], "Review the image push and task image reference.", "Fix image delivery", (id) => `/projects/${id}/pipeline?recovery=${code}`, "recovery_center", "registry_recovery"));
    }

    const stateSafetyEvidence = `${input.stateSafety.lockStatus} ${input.stateSafety.stateStatus} ${input.stateSafety.validationStatus}`;
    const authoritativeStateProblem = input.stateSafety.recoveryRequired && /failed|stale|orphaned|recovery_required|corrupted/i.test(stateSafetyEvidence);
    const activeInfrastructureFailure = /terraform.*(?:plan|apply).*failed|AWS credentials missing|AccessDenied|quota exceeded|VPC|subnet|NAT gateway|cloud map|secrets manager/i.test(combined);
    if (authoritativeStateProblem || activeInfrastructureFailure) {
      const code = authoritativeStateProblem
        ? /stale|orphaned|failed/i.test(input.stateSafety.lockStatus)
          ? "state_lock_stuck"
          : /corrupted/i.test(`${input.stateSafety.stateStatus} ${input.stateSafety.validationStatus}`)
            ? "state_corruption_detected"
            : "state_recovery_required"
        : /AWS credentials missing/i.test(combined) ? "aws_credentials_missing" : /accessdenied|permission denied/i.test(combined) ? "aws_permission_denied" : /quota/i.test(combined) ? "quota_exceeded" : /NAT gateway/i.test(combined) ? "nat_gateway_failure" : /cloud map/i.test(combined) ? "cloud_map_failure" : /secrets manager/i.test(combined) ? "secrets_manager_failure" : /VPC|subnet/i.test(combined) ? "vpc_or_subnet_failure" : /plan/i.test(combined) ? "terraform_plan_failed" : "terraform_apply_failed";
      results.push(this.issue(9, code, "Infrastructure provisioning needs attention", "blocker", "terraform", this.line(combined, /state|terraform|AWS|AccessDenied|quota|VPC|subnet|NAT|cloud map|secrets manager/i), "Cloud infrastructure could not reach the next safe state.", [{ source: "terraform", message: this.line(combined, /state|terraform|AWS|AccessDenied|quota|VPC|subnet|NAT|cloud map|secrets manager/i) }], "Review the one failing resource or permission without rebuilding the image.", "Open infrastructure recovery", (id) => `/projects/${id}/${code.startsWith("state_") ? "state" : "infrastructure"}?recovery=${code}`, "recovery_center", "infrastructure_recovery"));
    }

    if (
      !input.stateSafety.recoveryRequired &&
      input.stateSafety.stateStatus === "recovered" &&
      !input.isDeploymentJobActive &&
      !currentRunReachedHealthVerification &&
      ["unhealthy", "stale_live_record", "failed"].includes(input.cloudState.deploymentStatus)
    ) {
      results.push(this.issue(9, "terraform_recovery_completed_resume", "Infrastructure state recovered", "warning", "terraform", "Terraform state is recovered, validated, and unlocked, but the application deployment is not healthy.", "Infrastructure is already provisioned. DeployGuard can resume from infrastructure planning without rebuilding a valid image.", [{ source: "terraform", message: `State ${input.stateSafety.stateStatus}; lock ${input.stateSafety.lockStatus}; validation ${input.stateSafety.validationStatus}.`, timestamp: input.stateSafety.authoritativeTimestamp || undefined }], "Resume from Terraform plan, then continue database provisioning, ECS redeploy, and health verification using valid checkpoints.", "Resume deployment", (id) => `/projects/${id}/recovery`, "recovery_center", "infrastructure_recovery"));
    }

    if (
      input.deployment
      && ["failed", "unhealthy", "rollback_failed"].includes(input.deployment.status)
      && !databaseLocalhost
      && failureClass !== "application_health_failed"
    ) {
      const code = this.ecsDiagnostics.runtimeCode(combined);
      const portMismatch = ["wrong_port_binding", "app_bound_to_localhost"].includes(code);
      results.push(this.issue(10, code, portMismatch ? "Runtime port needs attention" : "Application container crashed", "critical", portMismatch ? "network" : "runtime", diagnostics?.summary || input.deployment.errorMessage || "The ECS task stopped before becoming healthy.", portMismatch ? "Your app is not listening on the address and port expected by the cloud load balancer." : "The application process exited inside ECS.", [{ source: "ecs", message: diagnostics?.stoppedTaskReason || diagnostics?.summary || input.deployment.errorMessage || "ECS task stopped." }, ...(diagnostics?.logLines?.slice(-1).map((message) => ({ source: "cloudwatch" as const, message })) || [])], portMismatch ? "Correct the runtime port or bind address." : "Review the stopped task reason and last meaningful application log.", portMismatch ? "Fix runtime port" : "Open runtime recovery", (id) => `/projects/${id}/recovery`, "recovery_center", "runtime_recovery", { diagnosticCode: diagnostics?.diagnosticCode || null, containerExitCode: diagnostics?.containerExitCode ?? null, containerPort: diagnostics?.containerPort ?? input.contract?.port ?? null, targetPort: diagnostics?.targetPort ?? null }));
    }

    const healthFailure = currentRunReachedHealthVerification && (
      (cloudHealthBelongsToCurrentRun && input.cloudState.healthStatus === "unreachable") ||
      /health check|target group unhealthy|HTTP 404|alb 50[23]|no targets|health.*timeout|starts but health/i.test(combined)
    );
    if (healthFailure && !databaseLocalhost) {
      const legacyCode = this.ecsDiagnostics.healthCode(combined);
      results.push(this.issue(11, "application_health_failed", "Application health check failed", "blocker", "health", this.line(combined, /health|target|404|502|503/i), "Your app started, but the configured health endpoint did not become healthy.", [{ source: "alb", message: this.line(combined, /health|target|404|502|503/i) }], "Review the health path, port, and startup grace period.", "Fix health check", (id) => `/projects/${id}/settings?recovery=application_health_failed&focus=health_check`, "focused_settings", "health_check", { failureClass: "application_health_failed", legacyFailureCode: legacyCode }));
    }

    if (input.cost && ["rejected", "blocked_by_tier_limit", "failed", "approval_required", "warning_over_tier"].includes(String(input.cost.status))) {
      const code = input.cost.status === "failed" ? "infracost_unavailable" : input.cost.status === "blocked_by_tier_limit" ? "budget_exceeded" : input.cost.status === "rejected" ? "cost_gate_blocked" : /NAT gateway/i.test(combined) ? "nat_gateway_cost_warning" : input.cost.status === "warning_over_tier" ? "high_cost_resource_detected" : "cost_gate_blocked";
      const warning = ["infracost_unavailable", "high_cost_resource_detected", "nat_gateway_cost_warning"].includes(code);
      results.push(this.issue(12, code, warning ? "Cost review recommended" : "Cost approval required", warning ? "warning" : "blocker", "cost", input.cost.errorMessage || input.cost.upgradePromptMessage || `Cost estimate status: ${input.cost.status}.`, warning ? "Deployment cost information needs review, but unrelated application settings do not." : "The deployment is waiting for a cost decision.", [{ source: "terraform", message: input.cost.errorMessage || input.cost.upgradePromptMessage || `Cost estimate status: ${input.cost.status}.` }], "Review the current estimate and approval state.", "Open cost review", (id) => `/projects/${id}/costs?recovery=${code}`, "recovery_center", "cost_review"));
    }

    if (input.cloudState.cleanupRequiredForCurrentRun || input.cloudState.projectCleanupRecommended) {
      const explanation = input.cloudState.statusExplanation;
      const code = /TTL.*expired/i.test(explanation) ? "ttl_expired" : /protected resources/i.test(explanation) ? "protected_resources_only" : /stale live record.*destroy/i.test(explanation) ? "stale_live_record_after_destroy" : /destroy.*cleanup/i.test(explanation) ? "destroy_needs_cleanup" : input.cloudState.nextAction === "clean_safe_leftovers" ? "safe_leftovers_available" : input.cloudState.resourceStatus === "manual_review_required" ? "manual_review_required" : "cloud_residue_found";
      results.push(this.issue(12, code, "Cloud cleanup required", "warning", "cleanup", input.cloudState.statusExplanation, "The app is not live, but project-scoped cloud resources may still exist.", [{ source: "terraform", message: input.cloudState.statusExplanation }], "Review verified project resources and use their safe cleanup path.", "Open resource cleanup", (id) => `/projects/${id}/settings?recovery=${code}&focus=resource_cleanup`, "focused_settings", "resource_cleanup"));
    }

    return results;
  }

  private issue(priority: number, code: string, title: string, severity: RecoverySeverity, category: RecoveryCategory, rootCause: string, simpleExplanation: string, detectedEvidence: RecoveryEvidence[], requiredAction: string, primaryActionLabel: string, route: (projectId: string) => string, primaryActionMode: RecoveryIssue["primaryActionMode"], focusSection: string | null, developerDetails?: Record<string, unknown>): Candidate {
    return { priority, code, title, severity, category, rootCause, simpleExplanation, detectedEvidence: detectedEvidence.filter((item) => item.message).slice(0, 3), requiredAction, primaryActionLabel, route, primaryActionMode, focusSection, developerDetails };
  }

  private line(value: string, pattern: RegExp) {
    return value.split(/\r?\n/).find((line) => pattern.test(line))?.trim().slice(0, 320) || "A blocking deployment signal was detected.";
  }
}
