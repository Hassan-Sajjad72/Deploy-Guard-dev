import { Injectable } from "@nestjs/common";
import { AuthoritativeProjectCloudState } from "../../infrastructure-lifecycle/cloud-state-reconciliation.service";
import { ProjectInfrastructureEnvironment } from "../../infrastructure/project-infrastructure-environment.entity";
import { ProjectDeployment } from "../../orchestration/project-deployment.entity";
import { ProjectPersistentStorage } from "../../storage/project-persistent-storage.entity";
import { ProjectDatabaseTier } from "../project-database-tier.entity";
import { ProjectDeploymentContract } from "../project-deployment-contract.entity";
import { ProjectPipelineEvent } from "../project-pipeline-event.entity";
import { ProjectPipelineRun } from "../project-pipeline-run.entity";
import { ProjectPreflightReport } from "../project-preflight-report.entity";
import { ProjectSecurityScan } from "../project-security-scan.entity";
import { ProjectTerraformLock } from "../../state-management/project-terraform-lock.entity";
import { DeploymentCheckpointService } from "./deployment-checkpoint.service";
import { RecoveryCategory, RecoveryEvidence, RecoveryIssue, RecoverySeverity } from "./recovery-issue.types";

type PlannerInput = {
  projectId: string;
  repositoryFullName: string | null;
  branch: string | null;
  contract: ProjectDeploymentContract | null;
  preflight: ProjectPreflightReport | null;
  run: ProjectPipelineRun | null;
  events: ProjectPipelineEvent[];
  scan: ProjectSecurityScan | null;
  environment: ProjectInfrastructureEnvironment | null;
  lock: ProjectTerraformLock | null;
  storage: ProjectPersistentStorage | null;
  deployment: ProjectDeployment | null;
  databaseTier: ProjectDatabaseTier | null;
  cloudState: AuthoritativeProjectCloudState;
  isDeploymentJobActive: boolean;
};

type Candidate = Omit<RecoveryIssue, "primaryActionRoute" | "resumeFromStage" | "canResume" | "requiresFullRerun" | "affectedStages" | "safeToRetry" | "developerDetails"> & {
  priority: number;
  route: (projectId: string) => string;
  developerDetails?: Record<string, unknown>;
};

@Injectable()
export class DeploymentRecoveryPlanner {
  constructor(private readonly checkpoints: DeploymentCheckpointService) {}

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
        deploymentId: input.deployment?.id || null,
        checkpointFingerprints: this.checkpoints.fingerprints(input.contract, input.run),
        ...developerDetails,
      },
    };
  }

  private candidates(input: PlannerInput): Candidate[] {
    const results: Candidate[] = [];
    const diagnostics = this.diagnostics(input.deployment);
    const combined = [
      input.run?.errorMessage, input.deployment?.errorMessage,
      ...(input.contract?.blockers || []), ...(input.preflight?.errors || []),
      ...input.events.filter((event) => ["failed", "blocked", "error"].includes(event.status)).map((event) => event.message),
      diagnostics?.summary, ...(diagnostics?.logLines || []), ...(diagnostics?.taskEvents || []),
    ].filter(Boolean).join("\n");

    if (input.cloudState.inventoryStatus === "unavailable_auth_required") {
      results.push(this.issue(1, "aws_permission_reauth_required", "Cloud access needs attention", "critical", "auth", "DeployGuard could not authenticate while verifying this project's cloud resources.", "Cloud resource status cannot be trusted until AWS access is restored.", [{ source: "settings", message: "Cloud inventory authentication failed." }], "Restore the configured AWS credentials, then refresh cloud inventory.", "Review cloud access", () => "/login", "external", "cloud_auth"));
    }
    if (!input.repositoryFullName) {
      results.push(this.issue(2, "github_repo_missing", "Connect a repository", "blocker", "source", "No GitHub repository is connected to this project.", "DeployGuard needs a source repository before it can analyze or deploy the app.", [{ source: "github", message: "Repository full name is missing." }], "Connect a GitHub repository and choose a branch.", "Connect repository", (id) => `/projects/${id}/settings?recovery=github_repo_missing&focus=repository_source`, "focused_settings", "repository_source"));
    } else if (/repository not found|authentication failed|could not read from remote|permission denied|branch .* not found|remote branch/i.test(combined)) {
      const branch = /branch .* not found|remote branch/i.test(combined);
      results.push(this.issue(2, branch ? "branch_not_found" : "repo_private_access_failed", branch ? "Deployment branch not found" : "Repository access failed", "blocker", "source", this.line(combined, /repository|authentication|permission|branch/i), branch ? "The selected branch is unavailable." : "DeployGuard cannot read the selected repository with the current GitHub access.", [{ source: "github", message: this.line(combined, /repository|authentication|permission|branch/i) }], branch ? "Choose an existing deployment branch." : "Reconnect GitHub access for this repository.", branch ? "Choose branch" : "Reconnect GitHub", (id) => `/projects/${id}/settings?recovery=${branch ? "branch_not_found" : "repo_private_access_failed"}&focus=repository_source`, "focused_settings", "repository_source"));
    }

    const blockers = [...(input.contract?.blockers || []), ...(input.preflight?.errors || [])];
    if (blockers.length) {
      const text = blockers.join(" ");
      if (input.contract?.missingEnvVars?.length || /missing|required.*environment|environment variable/i.test(text)) {
        const buildTime = input.contract?.missingEnvVars?.some((key) => input.contract?.buildTimeEnvVars?.includes(key));
        results.push(this.issue(4, buildTime ? "missing_build_time_env_vars" : "missing_runtime_env_vars", "Configuration values required", "blocker", "runtime", blockers[0], "Your app needs configuration values before it can start safely.", [{ source: "preflight", message: `${input.contract?.missingEnvVars?.join(", ") || blockers[0]}` }], "Complete the unresolved deployment requirements. Saved secret values remain masked.", "Complete requirements", (id) => `/projects/${id}/requirements?focus=secrets`, "focused_settings", "missing_environment_variables"));
      } else if (/unsupported language|unsupported framework|manifest|start command|build command|app (?:root|directory)|monorepo|ambiguous/i.test(text)) {
        const code = /monorepo|ambiguous/i.test(text) ? "monorepo_app_path_required" : /manifest/i.test(text) ? "missing_package_manifest" : /start command/i.test(text) ? "missing_start_command" : /build command/i.test(text) ? "missing_build_command" : /unsupported language/i.test(text) ? "unsupported_language" : "unsupported_framework";
        results.push(this.issue(3, code, "Repository setup needs attention", "blocker", "source", blockers[0], "DeployGuard could not prove which application or runtime should be deployed.", [{ source: "preflight", message: blockers[0] }], "Correct the detected application path or runtime command, then re-run analysis.", "Fix repository analysis", (id) => `/projects/${id}/settings?recovery=${code}&focus=detection_override`, "focused_settings", "detection_override"));
      }
    }

    const databaseLocalhost = /(?:ECONNREFUSED|connection refused)[^\n]{0,140}(?:127\.0\.0\.1|localhost|::1)(?::(?:5432|3306))?|database at localhost|localhost is the application container/i.test(combined);
    if (databaseLocalhost) {
      const line = this.line(combined, /ECONNREFUSED|connection refused|database at localhost|localhost is the application container/i);
      results.push(this.issue(3, "app_connected_to_localhost_database", "Database setup required", "critical", "database", "The app is trying to connect to PostgreSQL at 127.0.0.1:5432 inside the app container.", "In cloud deployment, localhost means inside the app container, not the database service.", [{ source: diagnostics?.logLines?.length ? "cloudwatch" : "ecs", message: line, timestamp: input.deployment?.failedAt?.toISOString() }], "Choose a managed database or provide a reachable external database in Deployment Requirements.", "Complete database requirements", (id) => `/projects/${id}/requirements?focus=database`, "focused_settings", "database_setup", { diagnosticCode: diagnostics?.diagnosticCode || "DATABASE_LOCALHOST_UNREACHABLE", containerExitCode: diagnostics?.containerExitCode ?? null }));
    } else if (input.contract?.databaseRequired && (!input.databaseTier?.provider || input.databaseTier.provider === "none")) {
      results.push(this.issue(5, "database_required_but_not_configured", "Database setup required", "blocker", "database", "Repository analysis found a database dependency, but no reachable database tier is configured.", "Your application needs a private managed database or a reachable external endpoint.", [{ source: "database", message: `Detected database engine: ${input.contract.databaseEngine || "database"}.` }], "Choose a managed database or enter an external database endpoint.", "Complete database requirements", (id) => `/projects/${id}/requirements?focus=database`, "focused_settings", "database_setup"));
    }

    if (input.storage?.status === "failed" || /EFS|mount.*failed|permission denied.*mount|access point/i.test(combined)) {
      results.push(this.issue(5, /permission denied/i.test(combined) ? "efs_permission_denied" : "efs_mount_failed", "Persistent storage needs attention", "blocker", "storage", input.storage?.errorMessage || this.line(combined, /EFS|mount|access point/i), "The application cannot use its configured persistent file storage.", [{ source: "efs", message: input.storage?.errorMessage || this.line(combined, /EFS|mount|access point/i) }], "Review the project storage mount and permissions.", "Fix storage", (id) => `/projects/${id}/storage?recovery=efs_mount_failed`, "recovery_center", "storage_setup"));
    }

    if (/docker build|npm (?:ci|install)|yarn install|pnpm install|module not found|cannot find module|dockerfile/i.test(combined)) {
      const code = /module not found|cannot find module/i.test(combined) ? "module_not_found" : /npm|yarn|pnpm/i.test(combined) ? "dependency_install_failed" : "docker_build_failed";
      results.push(this.issue(6, code, "Image build failed", "blocker", "build", this.line(combined, /docker|npm|yarn|pnpm|module/i), "DeployGuard could not build a runnable application image.", [{ source: "docker", message: this.line(combined, /docker|npm|yarn|pnpm|module/i) }], "Review the failed build command and meaningful log line.", "Open build fix", (id) => `/projects/${id}/pipeline?recovery=${code}`, "recovery_center", "build_fix"));
    }

    if (input.scan && /blocked/i.test(String(input.scan.policyDecision || ""))) {
      results.push(this.issue(7, "critical_vulnerability_blocked", "Security policy blocked this image", "blocker", "security", "The latest image violates the configured container security policy.", "A blocking image or Dockerfile finding must be resolved before release.", [{ source: "trivy", message: "Security policy decision: blocked." }], "Open the security report and remediate the blocking finding.", "Open security report", (id) => `/projects/${id}/security?recovery=critical_vulnerability_blocked`, "recovery_center", "security_fix"));
    }

    if (/CannotPullContainerError|pull image|ECR|image manifest|no basic auth credentials/i.test(combined)) {
      const code = /auth|credentials/i.test(combined) ? "ecr_auth_failed" : /not found|manifest/i.test(combined) ? "image_not_found" : "image_pull_failed";
      results.push(this.issue(8, code, "Container image unavailable", "blocker", "runtime", this.line(combined, /pull image|ECR|manifest|auth|credentials/i), "ECS could not retrieve the application image.", [{ source: "ecs", message: this.line(combined, /pull image|ECR|manifest|auth|credentials/i) }], "Review the image push and task image reference.", "Fix image delivery", (id) => `/projects/${id}/pipeline?recovery=${code}`, "recovery_center", "registry_recovery"));
    }

    if (input.lock && /failed|stale|recovery|required|waiting/i.test(String(input.lock.status)) || /state lock|terraform.*(?:plan|apply).*failed|AccessDenied|quota exceeded|cloud map/i.test(combined)) {
      const code = /state lock|stale lock/i.test(combined) ? "state_lock_stuck" : /accessdenied|permission denied/i.test(combined) ? "aws_permission_denied" : /quota/i.test(combined) ? "quota_exceeded" : /plan/i.test(combined) ? "terraform_plan_failed" : "terraform_apply_failed";
      results.push(this.issue(9, code, "Infrastructure provisioning needs attention", "blocker", "terraform", this.line(combined, /state lock|terraform|AccessDenied|quota|cloud map/i), "Cloud infrastructure could not reach the next safe state.", [{ source: "terraform", message: this.line(combined, /state lock|terraform|AccessDenied|quota|cloud map/i) }], "Review the exact Terraform or state failure without rebuilding the image.", "Open infrastructure recovery", (id) => `/projects/${id}/${code.startsWith("state_") ? "state" : "infrastructure"}?recovery=${code}`, "recovery_center", "infrastructure_recovery"));
    }

    if (input.deployment && ["failed", "unhealthy", "rollback_failed"].includes(input.deployment.status) && !databaseLocalhost) {
      const portMismatch = /listening on port|port mismatch|expected port|localhost-only|bound to localhost/i.test(combined);
      const code = portMismatch ? (/localhost-only|bound to localhost/i.test(combined) ? "app_bound_to_localhost" : "wrong_port_binding") : /out of memory|oom/i.test(combined) ? "oom_killed" : "container_crashed";
      results.push(this.issue(10, code, portMismatch ? "Runtime port needs attention" : "Application container crashed", "critical", portMismatch ? "network" : "runtime", diagnostics?.summary || input.deployment.errorMessage || "The ECS task stopped before becoming healthy.", portMismatch ? "Your app is not listening on the address and port expected by the cloud load balancer." : "The application process exited inside ECS.", [{ source: "ecs", message: diagnostics?.stoppedTaskReason || diagnostics?.summary || input.deployment.errorMessage || "ECS task stopped." }, ...(diagnostics?.logLines?.slice(-1).map((message) => ({ source: "cloudwatch" as const, message })) || [])], portMismatch ? "Correct the runtime port or bind address." : "Review the stopped task reason and last meaningful application log.", portMismatch ? "Fix runtime port" : "Open runtime recovery", (id) => `/projects/${id}/recovery`, "recovery_center", "runtime_recovery", { diagnosticCode: diagnostics?.diagnosticCode || null, containerExitCode: diagnostics?.containerExitCode ?? null, containerPort: diagnostics?.containerPort ?? input.contract?.port ?? null, targetPort: diagnostics?.targetPort ?? null }));
    }

    const healthFailure = input.cloudState.healthStatus === "unreachable" || /health check|target group unhealthy|HTTP 404|alb 50[23]|no targets/i.test(combined);
    if (healthFailure && !databaseLocalhost) {
      const code = /404/.test(combined) ? "health_check_path_missing" : /no targets/i.test(combined) ? "no_targets_registered" : /502/.test(combined) ? "alb_502" : /503/.test(combined) ? "alb_503" : "target_group_unhealthy";
      results.push(this.issue(11, code, "Application health check failed", "blocker", "health", this.line(combined, /health|target|404|502|503/i), "Your app started, but the configured health endpoint did not become healthy.", [{ source: "alb", message: this.line(combined, /health|target|404|502|503/i) }], "Review the health path, port, and startup grace period.", "Fix health check", (id) => `/projects/${id}/settings?recovery=${code}&focus=health_check`, "focused_settings", "health_check"));
    }

    if (["cleanup_required", "manual_review_required"].includes(input.cloudState.resourceStatus) || ["cleanup_required", "cleanup_failed", "manual_review_required"].includes(input.cloudState.cleanupStatus)) {
      const code = input.cloudState.nextAction === "clean_safe_leftovers" ? "safe_leftovers_available" : input.cloudState.resourceStatus === "manual_review_required" ? "manual_review_required" : "cloud_residue_found";
      results.push(this.issue(12, code, "Cloud cleanup required", "warning", "cleanup", input.cloudState.statusExplanation, "The app is not live, but project-scoped cloud resources may still exist.", [{ source: "terraform", message: input.cloudState.statusExplanation }], "Review verified project resources and use their safe cleanup path.", "Open resource cleanup", (id) => `/projects/${id}/settings?recovery=${code}&focus=resource_cleanup`, "focused_settings", "resource_cleanup"));
    }

    return results;
  }

  private issue(priority: number, code: string, title: string, severity: RecoverySeverity, category: RecoveryCategory, rootCause: string, simpleExplanation: string, detectedEvidence: RecoveryEvidence[], requiredAction: string, primaryActionLabel: string, route: (projectId: string) => string, primaryActionMode: RecoveryIssue["primaryActionMode"], focusSection: string | null, developerDetails?: Record<string, unknown>): Candidate {
    return { priority, code, title, severity, category, rootCause, simpleExplanation, detectedEvidence: detectedEvidence.filter((item) => item.message).slice(0, 3), requiredAction, primaryActionLabel, route, primaryActionMode, focusSection, developerDetails };
  }

  private diagnostics(deployment: ProjectDeployment | null): any {
    return (deployment?.metadata?.ecsStability as any)?.diagnostics || (deployment?.metadata as any)?.ecsDiagnostics || null;
  }

  private line(value: string, pattern: RegExp) {
    return value.split(/\r?\n/).find((line) => pattern.test(line))?.trim().slice(0, 320) || "A blocking deployment signal was detected.";
  }
}
