import { Injectable } from "@nestjs/common";
import { LogSanitizerService } from "../../observability/log-sanitizer.service";
import { ExternalProvider, FailureOwner } from "../failure-ownership";
import {
  DeploymentFailureDiagnostic,
  DeploymentFailureDiagnosticInput,
  FAILURE_DIAGNOSTIC_SCHEMA_VERSION,
  FailureDiagnosticConfidence,
  FailureRetryDecision,
} from "./failure-diagnostic.types";

type Diagnosis = {
  rootCauseCode: string;
  owner?: FailureOwner;
  provider?: ExternalProvider | null;
  affectedComponent: string;
  tool?: string;
  toolErrorCode?: string;
  summary: string;
  technicalReason: string;
  recommendedAction: string;
  remediationSteps: string[];
  retryDecision: FailureRetryDecision;
  confidence: FailureDiagnosticConfidence;
  evidencePattern?: RegExp;
};

const repositoryFix = (tool: string, rootCauseCode: string, toolErrorCode: string | undefined, summary: string, technicalReason: string, action: string, pattern: RegExp): Diagnosis => ({
  rootCauseCode, owner: "REPOSITORY_APPLICATION", affectedComponent: "Repository dependency configuration", tool, toolErrorCode,
  summary, technicalReason, recommendedAction: action,
  remediationSteps: [action, "Commit and push the corrected repository-owned files.", "Deploy the new immutable source commit."],
  retryDecision: "SAFE_AFTER_FIX", confidence: "DETERMINISTIC", evidencePattern: pattern,
});

const structured: Record<string, Omit<Diagnosis, "confidence">> = {
  DG_DEPLOYMENT_INPUT_REQUIRED: { rootCauseCode: "DG_CONFIGURATION_INPUT_REQUIRED", affectedComponent: "Service configuration", summary: "Required deployment configuration is missing.", technicalReason: "Requirement admission identified unresolved required input before workflow dispatch.", recommendedAction: "Provide the exact missing service-scoped configuration and submit a new deployment.", remediationSteps: ["Review the unresolved required inputs.", "Configure them for the affected service.", "Submit deployment admission again."], retryDecision: "NOT_SAFE_YET" },
  DG_DEPLOYMENT_REQUIREMENTS_BLOCKED: { rootCauseCode: "DG_CONFIGURATION_ADMISSION_BLOCKED", affectedComponent: "Service configuration", summary: "Deployment configuration was blocked.", technicalReason: "Requirement admission found a prohibited override, duplicate conflict, or validation blocker.", recommendedAction: "Resolve the reported configuration conflict before deploying.", remediationSteps: ["Review the persisted admission blockers.", "Correct the affected service configuration.", "Submit deployment admission again."], retryDecision: "NOT_SAFE_YET" },
  DG_SERVICE_PORT_UNRESOLVED: { rootCauseCode: "DG_APPLICATION_PORT_UNRESOLVED", affectedComponent: "Application port contract", summary: "The application port could not be resolved.", technicalReason: "Repository evidence did not establish one canonical service port.", recommendedAction: "Declare one supported service port and deploy a new commit.", remediationSteps: ["Declare the service port in supported repository configuration.", "Commit the change.", "Deploy the new commit."], retryDecision: "SAFE_AFTER_FIX" },
  DG_SERVICE_PORT_CONFLICT: { rootCauseCode: "DG_APPLICATION_PORT_CONFLICT", affectedComponent: "Application port contract", summary: "Conflicting application ports were declared.", technicalReason: "Repository-owned port evidence disagrees.", recommendedAction: "Make the service port declarations consistent and deploy a new commit.", remediationSteps: ["Review the reported port sources.", "Choose one canonical port.", "Commit and deploy the correction."], retryDecision: "SAFE_AFTER_FIX" },
  DG_SERVICE_PORT_INVALID: { rootCauseCode: "DG_APPLICATION_PORT_INVALID", affectedComponent: "Application port contract", summary: "The declared application port is invalid.", technicalReason: "The repository supplied a port outside the supported runtime contract.", recommendedAction: "Correct the service port and deploy a new commit.", remediationSteps: ["Correct the invalid port declaration.", "Commit the change.", "Deploy the new commit."], retryDecision: "SAFE_AFTER_FIX" },
  DG_APPLICATION_RUNTIME_FAILED: { rootCauseCode: "DG_APPLICATION_STARTUP_OR_RUNTIME_FAILED", affectedComponent: "Application runtime", summary: "The application did not start or remain healthy.", technicalReason: "Structured application runtime evidence identifies an application-owned failure.", recommendedAction: "Correct the application startup/runtime failure and deploy a new commit.", remediationSteps: ["Inspect the relevant sanitized runtime evidence.", "Correct the application startup or runtime behavior.", "Deploy the fixed commit."], retryDecision: "SAFE_AFTER_FIX" },
  DG_RAILPACK_PREREQUISITE_FAILED: { rootCauseCode: "DG_RAILPACK_PROVIDER_PREREQUISITE_FAILED", affectedComponent: "Railpack provider", summary: "Railpack prerequisites were unavailable.", technicalReason: "The existing provider boundary identified a Railpack prerequisite failure.", recommendedAction: "Retry after Railpack prerequisites are available.", remediationSteps: ["Review provider evidence.", "Retry the operation when the prerequisite is available."], retryDecision: "SAFE_NOW" },
  DG_GITHUB_PROVIDER_FAILED: { rootCauseCode: "DG_GITHUB_PROVIDER_OPERATION_FAILED", affectedComponent: "GitHub Actions", summary: "GitHub could not accept or execute the operation.", technicalReason: "The existing GitHub provider boundary identified the failure.", recommendedAction: "Verify GitHub availability and authorization, then retry.", remediationSteps: ["Review the GitHub provider evidence.", "Restore authorization or wait for provider recovery.", "Retry the operation."], retryDecision: "SAFE_NOW" },
  DG_TERRAFORM_APPLY_FAILED: { rootCauseCode: "DG_AWS_TERRAFORM_APPLY_FAILED", affectedComponent: "Terraform/AWS infrastructure", summary: "Terraform could not apply the infrastructure change.", technicalReason: "The workflow emitted the authoritative Terraform apply boundary.", recommendedAction: "Review the bounded Terraform/AWS evidence and retry only after the provider condition is resolved.", remediationSteps: ["Review the relevant Terraform evidence.", "Resolve the reported AWS/provider condition.", "Retry using the existing lifecycle operation."], retryDecision: "NOT_SAFE_YET" },
  DG_ECR_PUBLISH_FAILED: { rootCauseCode: "DG_AWS_ECR_PUBLICATION_FAILED", affectedComponent: "Amazon ECR", summary: "The deployment image could not be published.", technicalReason: "The workflow emitted the authoritative ECR publication boundary.", recommendedAction: "Resolve the AWS/ECR provider condition, then retry.", remediationSteps: ["Review ECR provider evidence.", "Restore the required AWS capability.", "Retry the operation."], retryDecision: "NOT_SAFE_YET" },
  DG_ECS_STABILITY_FAILED: { rootCauseCode: "DG_ECS_SERVICE_STABILITY_FAILED", affectedComponent: "Amazon ECS service", summary: "The ECS service did not reach stable healthy state.", technicalReason: "Structured ECS diagnostics identified the service stability boundary.", recommendedAction: "Follow the existing ECS ownership evidence before retrying.", remediationSteps: ["Review the service-scoped ECS diagnostics.", "Resolve the proven application, platform, or provider condition.", "Retry only after that condition changes."], retryDecision: "NOT_SAFE_YET" },
  DG_MANAGED_DATABASE_READINESS_FAILED: { rootCauseCode: "DG_MANAGED_DATABASE_PLATFORM_READINESS_FAILED", affectedComponent: "Managed database readiness", summary: "The managed database did not become ready.", technicalReason: "DeployGuard's platform-owned managed database readiness verification failed.", recommendedAction: "Resolve the platform database readiness condition before retrying.", remediationSteps: ["Review the managed database readiness evidence.", "Correct the platform condition.", "Retry the deployment."], retryDecision: "NOT_SAFE_YET" },
  DG_MANAGED_MYSQL_GRANT_RECONCILIATION_FAILED: { rootCauseCode: "DG_MANAGED_MYSQL_GRANT_RECONCILIATION_FAILED", affectedComponent: "Managed MySQL account grants", summary: "Managed MySQL grants could not be reconciled.", technicalReason: "DeployGuard's platform-owned MySQL account/grant reconciliation failed.", recommendedAction: "Resolve the platform grant reconciliation condition before retrying.", remediationSteps: ["Review the bounded MySQL reconciliation evidence.", "Correct the platform condition.", "Retry the deployment."], retryDecision: "NOT_SAFE_YET" },
  DG_WORKFLOW_CONTRACT_INVALID: { rootCauseCode: "DG_WORKFLOW_CONTRACT_INVALID", affectedComponent: "DeployGuard workflow contract", summary: "The workflow result contract was incompatible.", technicalReason: "DeployGuard rejected terminal evidence that did not match the immutable workflow contract.", recommendedAction: "Correct the DeployGuard control-plane/workflow contract before retrying.", remediationSteps: ["Verify the pinned workflow release identity.", "Correct the platform contract.", "Retry after the platform fix."], retryDecision: "NOT_SAFE_YET" },
  DG_CONTROL_PLANE_VERSION_MISMATCH: { rootCauseCode: "DG_CONTROL_PLANE_VERSION_MISMATCH", affectedComponent: "DeployGuard control plane", summary: "The backend and reusable workflow versions differ.", technicalReason: "The immutable control-plane compatibility check rejected different commit identities.", recommendedAction: "Pin the reusable workflow to the backend control-plane commit.", remediationSteps: ["Publish the current control-plane commit.", "Update the reusable workflow pin.", "Restart DeployGuard and submit deployment again."], retryDecision: "NOT_SAFE_YET" },
  DG_RELEASE_FINALIZATION_FAILED: { rootCauseCode: "DG_RELEASE_FINALIZATION_FAILED", affectedComponent: "DeployGuard release projection", summary: "DeployGuard could not finalize verified release evidence.", technicalReason: "The workflow succeeded, but local release finalization failed.", recommendedAction: "Retry finalization through the existing recovery flow.", remediationSteps: ["Retain the verified immutable release evidence.", "Retry the failed operation to re-run local finalization."], retryDecision: "SAFE_NOW" },
  DG_PROJECT_DELETE_CLEANUP_FAILED: { rootCauseCode: "DG_PROJECT_DELETE_CLEANUP_FAILED", affectedComponent: "DeployGuard project cleanup", summary: "Verified cloud deletion completed, but local cleanup did not.", technicalReason: "The destroy result was verified before the local control-plane cleanup failed.", recommendedAction: "Retry local cleanup without redispatching infrastructure deletion.", remediationSteps: ["Retain the verified destroy evidence.", "Retry the destroy recovery operation."], retryDecision: "SAFE_NOW" },
  DG_AWS_AUTHORIZATION_FAILED: { rootCauseCode: "DG_AWS_AUTHORIZATION_FAILED", affectedComponent: "AWS authorization", summary: "AWS rejected the deployment authorization.", technicalReason: "The existing AWS provider boundary identified an authorization failure.", recommendedAction: "Restore the required AWS authorization before retrying.", remediationSteps: ["Review the bounded AWS authorization evidence.", "Restore the required role or policy capability.", "Retry the operation."], retryDecision: "NOT_SAFE_YET" },
  DG_AWS_PROVIDER_FAILED: { rootCauseCode: "DG_AWS_PROVIDER_FAILED", affectedComponent: "AWS provider", summary: "An AWS provider operation failed.", technicalReason: "The existing AWS provider boundary identified the failure.", recommendedAction: "Retry after the provider condition is resolved.", remediationSteps: ["Review the bounded AWS provider evidence.", "Wait for recovery or correct the provider condition.", "Retry the operation."], retryDecision: "SAFE_NOW" },
  DG_AWS_RUNTIME_CONFIGURATION_FAILED: { rootCauseCode: "DG_AWS_RUNTIME_CONFIGURATION_FAILED", affectedComponent: "DeployGuard AWS runtime configuration", summary: "Generated AWS runtime configuration was invalid.", technicalReason: "DeployGuard's platform-owned runtime configuration boundary failed.", recommendedAction: "Correct the DeployGuard platform configuration before retrying.", remediationSteps: ["Review the bounded runtime-configuration evidence.", "Correct the platform configuration.", "Retry after the correction."], retryDecision: "NOT_SAFE_YET" },
  DG_TERRAFORM_MATERIALIZATION_FAILED: { rootCauseCode: "DG_TERRAFORM_MATERIALIZATION_FAILED", affectedComponent: "DeployGuard Terraform materialization", summary: "DeployGuard could not materialize the Terraform contract.", technicalReason: "The platform-owned Terraform materialization boundary failed.", recommendedAction: "Correct the DeployGuard materialization failure before retrying.", remediationSteps: ["Review the bounded materialization evidence.", "Correct the platform condition.", "Retry after the correction."], retryDecision: "NOT_SAFE_YET" },
  DG_TERRAFORM_VALIDATE_FAILED: { rootCauseCode: "DG_TERRAFORM_VALIDATE_FAILED", affectedComponent: "DeployGuard Terraform validation", summary: "Generated Terraform configuration failed validation.", technicalReason: "The platform-owned Terraform validation boundary rejected generated configuration.", recommendedAction: "Correct the DeployGuard Terraform generation defect before retrying.", remediationSteps: ["Review the bounded validation evidence.", "Correct the platform-generated configuration.", "Retry after the correction."], retryDecision: "NOT_SAFE_YET" },
  DG_TERRAFORM_PLAN_FAILED: { rootCauseCode: "DG_TERRAFORM_PLAN_FAILED", affectedComponent: "DeployGuard Terraform plan", summary: "Terraform planning failed at the platform boundary.", technicalReason: "The existing platform ownership table identifies Terraform planning as DeployGuard-owned.", recommendedAction: "Resolve the platform planning condition before retrying.", remediationSteps: ["Review the bounded plan evidence.", "Correct the platform condition.", "Retry after the correction."], retryDecision: "NOT_SAFE_YET" },
};

@Injectable()
export class FailureDiagnosticService {
  constructor(private readonly sanitizer: LogSanitizerService) {}

  diagnose(input: DeploymentFailureDiagnosticInput): DeploymentFailureDiagnostic {
    const evidence = this.safe(input.safeEvidence || input.errorMessage || "No terminal evidence was available.", 12_000);
    const diagnosis = this.classify(input.terminalFailureCode, input.failureStage, evidence);
    const owner = diagnosis.owner && input.failureOwner === "UNVERIFIED" ? diagnosis.owner : input.failureOwner;
    const provider = owner === "EXTERNAL_PROVIDER" ? (input.externalProvider || diagnosis.provider || null) : input.externalProvider || null;
    const excerpt = this.excerpt(evidence, diagnosis.evidencePattern);
    return {
      schemaVersion: FAILURE_DIAGNOSTIC_SCHEMA_VERSION,
      operationId: input.operationId,
      deploymentAction: input.deploymentAction,
      sourceSha: input.sourceSha || null,
      terminalState: "failed",
      terminalFailureCode: input.terminalFailureCode || "DG_FAILURE_UNVERIFIED",
      rootCauseCode: diagnosis.rootCauseCode,
      failureOwner: owner,
      externalProvider: provider,
      failureStage: input.failureStage || "unknown",
      serviceId: input.serviceId || null,
      serviceName: input.serviceName || null,
      affectedComponent: input.serviceName ? `${input.serviceName} — ${diagnosis.affectedComponent}` : diagnosis.affectedComponent,
      tool: diagnosis.tool || null,
      toolErrorCode: diagnosis.toolErrorCode || null,
      summary: diagnosis.summary,
      technicalReason: diagnosis.technicalReason,
      recommendedAction: diagnosis.recommendedAction,
      remediationSteps: diagnosis.remediationSteps,
      retryDecision: diagnosis.retryDecision,
      completedStages: this.completedStages(input.workflowStages),
      evidenceReferences: [{ source: input.evidenceSource, stage: input.failureStage || "unknown", eventId: input.evidenceEventId || input.operationId, timestamp: input.failedAt.toISOString(), excerpt }],
      confidence: diagnosis.confidence,
      failedAt: input.failedAt.toISOString(),
    };
  }

  private classify(terminalCode: string, stage: string, evidence: string): Diagnosis {
    if (/ERR_PNPM_OUTDATED_LOCKFILE|pnpm-lock\.yaml[^\n]{0,160}(?:not up to date|outdated)|frozen-lockfile[^\n]{0,120}(?:fail|mismatch)/i.test(evidence)) {
      const mismatch = evidence.match(/([@\w./-]*package\.json)[^\n]*?([@\w./-]+)\s*=\s*([^\s,;]+)[^\n]*?(?:lockfile|pnpm-lock\.yaml)[^\n]*?\2\s*=\s*([^\s,;]+)/i);
      const reason = mismatch
        ? `${mismatch[1]} requires ${mismatch[2]} ${mismatch[3]} while pnpm-lock.yaml records ${mismatch[4]}.`
        : "pnpm proved that the repository manifest and pnpm-lock.yaml do not match.";
      return repositoryFix("pnpm", "DG_REPOSITORY_LOCKFILE_OUTDATED", "ERR_PNPM_OUTDATED_LOCKFILE", "Dependency lockfile is out of date.", reason, "Regenerate pnpm-lock.yaml with the repository package manager; do not disable frozen-lockfile enforcement.", /ERR_PNPM_OUTDATED_LOCKFILE[\s\S]{0,800}?(?=\s+open \/var\/lib\/docker|$)/i);
    }
    const packageSignatures: Array<[RegExp, () => Diagnosis]> = [
      [/(?:npm ci|npm ERR!)[^\n]{0,220}(?:package-lock|lock file)[^\n]{0,220}(?:not in sync|out of date|mismatch|missing)/i, () => repositoryFix("npm", "DG_REPOSITORY_LOCKFILE_OUTDATED", undefined, "Dependency lockfile is out of date.", "npm proved that package.json and package-lock.json do not match.", "Regenerate package-lock.json with the repository package manager.", /(?:npm ci|npm ERR!)[^\n]{0,400}/i)],
      [/(?:YN0028|yarn[^\n]{0,120}(?:immutable|lockfile)[^\n]{0,120}(?:modified|fail|out of date))/i, () => repositoryFix("yarn", "DG_REPOSITORY_LOCKFILE_OUTDATED", "YN0028", "Dependency lockfile is out of date.", "Yarn's immutable install proved that repository dependency state would modify yarn.lock.", "Regenerate yarn.lock with the repository package manager.", /YN0028[^\n]{0,300}|yarn[^\n]{0,300}/i)],
      [/(?:bun install)[^\n]{0,180}(?:frozen|lockfile)[^\n]{0,180}(?:fail|changed|out of date)/i, () => repositoryFix("bun", "DG_REPOSITORY_LOCKFILE_OUTDATED", undefined, "Dependency lockfile is out of date.", "Bun proved that the repository manifest and lockfile do not match.", "Regenerate bun.lock or bun.lockb with the repository package manager.", /bun install[^\n]{0,400}/i)],
      [/(?:npm ERR! code ERESOLVE|ERESOLVE unable to resolve dependency tree)/i, () => repositoryFix("npm", "DG_REPOSITORY_DEPENDENCY_RESOLUTION_FAILED", "ERESOLVE", "Repository dependencies cannot be resolved.", "npm deterministically rejected the declared dependency graph.", "Correct the conflicting dependency declarations.", /ERESOLVE[^\n]{0,300}/i)],
      [/(?:ERR_PNPM_PEER_DEP_ISSUES|ERR_PNPM_NO_MATCHING_VERSION)/i, () => repositoryFix("pnpm", "DG_REPOSITORY_DEPENDENCY_RESOLUTION_FAILED", evidence.match(/ERR_PNPM_[A-Z_]+/)?.[0], "Repository dependencies cannot be resolved.", "pnpm deterministically rejected the declared dependency graph.", "Correct the conflicting dependency declarations.", /ERR_PNPM_[A-Z_]+[^\n]{0,300}/i)],
      [/(?:YN0002|YN0060|yarn[^\n]{0,100}resolution failed)/i, () => repositoryFix("yarn", "DG_REPOSITORY_DEPENDENCY_RESOLUTION_FAILED", evidence.match(/YN\d{4}/)?.[0], "Repository dependencies cannot be resolved.", "Yarn deterministically rejected the declared dependency graph.", "Correct the conflicting dependency declarations.", /YN\d{4}[^\n]{0,300}/i)],
      [/(?:bun[^\n]{0,120}(?:no version matching|failed to resolve|package not found))/i, () => repositoryFix("bun", "DG_REPOSITORY_DEPENDENCY_RESOLUTION_FAILED", undefined, "Repository dependencies cannot be resolved.", "Bun deterministically rejected the declared dependency graph.", "Correct the conflicting dependency declarations.", /bun[^\n]{0,300}/i)],
    ];
    for (const [pattern, make] of packageSignatures) if (pattern.test(evidence)) return make();

    const python: Array<[RegExp, string, string, string | undefined]> = [
      [/(?:ResolutionImpossible|Could not find a version that satisfies the requirement)/i, "pip", "DG_PYTHON_DEPENDENCY_RESOLUTION_FAILED", "ResolutionImpossible"],
      [/(?:SolverProblemError|version solving failed)[\s\S]{0,200}poetry/i, "poetry", "DG_PYTHON_DEPENDENCY_RESOLUTION_FAILED", "SolverProblemError"],
      [/(?:uv[^\n]{0,100}(?:no solution found|failed to resolve)|No solution found when resolving dependencies)/i, "uv", "DG_PYTHON_DEPENDENCY_RESOLUTION_FAILED", undefined],
      [/(?:pdm[^\n]{0,120}(?:resolution impossible|unable to find a resolution|candidate not found))/i, "pdm", "DG_PYTHON_DEPENDENCY_RESOLUTION_FAILED", undefined],
      [/(?:pipenv[^\n]{0,120}(?:locking failed|failed to lock)|Locking Failed!)/i, "pipenv", "DG_PYTHON_DEPENDENCY_RESOLUTION_FAILED", undefined],
    ];
    for (const [pattern, tool, code, toolCode] of python) if (pattern.test(evidence)) return repositoryFix(tool, code, toolCode, "Python dependencies cannot be resolved.", `${tool} deterministically rejected the repository dependency declarations.`, `Correct the ${tool} dependency declarations or lock state.`, pattern);

    if (/error TS\d{4}:|TypeScript compilation failed/i.test(evidence)) return repositoryFix("typescript", "DG_APPLICATION_COMPILATION_FAILED", evidence.match(/TS\d{4}/i)?.[0].toUpperCase(), "Application compilation failed.", "The TypeScript compiler reported a repository-owned source error.", "Correct the reported TypeScript source error.", /(?:error TS\d{4}:|TypeScript compilation failed)[^\n]{0,300}/i);
    if (/(?:ModuleNotFoundError|Cannot find module|Module not found: Error: Can't resolve)/i.test(evidence)) return repositoryFix(/ModuleNotFoundError/i.test(evidence) ? "python" : "javascript", "DG_APPLICATION_MODULE_MISSING", evidence.match(/ModuleNotFoundError|MODULE_NOT_FOUND/i)?.[0], "A required application module is missing.", "Application build or startup evidence identifies a missing repository dependency/module.", "Add or correct the missing declared module and its import.", /(?:ModuleNotFoundError|Cannot find module|Module not found)[^\n]{0,300}/i);
    if (/(?:npm|pnpm|yarn|bun) (?:run )?(?:build|compile)[^\n]{0,180}(?:failed|exit code [1-9]|ELIFECYCLE)/i.test(evidence)) return repositoryFix("application-build", "DG_APPLICATION_BUILD_SCRIPT_FAILED", undefined, "The application build command failed.", "The repository-owned build script returned a deterministic failure.", "Correct the application build script or source error.", /(?:npm|pnpm|yarn|bun)[^\n]{0,350}/i);
    if (/(?:Traceback \(most recent call last\)|uncaught exception|application failed to start|process exited with code [1-9])/i.test(evidence) && /(?:startup|runtime|health|application|server)/i.test(`${stage} ${evidence}`)) return repositoryFix(/Traceback/i.test(evidence) ? "python" : "application", "DG_APPLICATION_STARTUP_OR_RUNTIME_FAILED", undefined, "The application failed during startup or runtime.", "Application process evidence proves an application exception or non-zero exit.", "Correct the application startup/runtime error.", /(?:Traceback \(most recent call last\)|uncaught exception|application failed to start|process exited with code [1-9])[^\n]{0,300}/i);
    if (/application database (?:connection|authentication) failed/i.test(evidence)) return repositoryFix("application", "DG_APPLICATION_DATABASE_CONSUMPTION_FAILED", undefined, "The application could not consume its database configuration.", "Application-owned runtime evidence proves failure while consuming the supplied database contract.", "Correct the application database client configuration or usage.", /application database (?:connection|authentication) failed[^\n]{0,300}/i);
    if (/(?:static output directory|static artifact)[^\n]{0,160}(?:missing|not found|empty)/i.test(evidence)) return repositoryFix("application-build", "DG_STATIC_OUTPUT_MISSING", undefined, "The static application output is missing.", "The application build completed without the configured static output artifact.", "Correct the application static build/output configuration.", /(?:static output directory|static artifact)[^\n]{0,300}/i);

    const existing = structured[terminalCode];
    if (existing) return { ...existing, confidence: "DETERMINISTIC" };
    return {
      rootCauseCode: "DG_FAILURE_CAUSE_UNVERIFIED", affectedComponent: "Deployment operation", summary: "The deployment failed, but the specific cause is not verified.",
      technicalReason: "Terminal evidence was captured, but no authoritative structured code or sufficiently unique signature proves a more specific cause.",
      recommendedAction: "Review the relevant sanitized evidence or ask AI for evidence-bound assistance before deciding whether to retry.",
      remediationSteps: ["Review the relevant sanitized evidence.", "Use evidence-bound AI troubleshooting if useful.", "Do not assume retry is safe until the cause is understood."],
      retryDecision: "INSUFFICIENT_EVIDENCE", confidence: "UNVERIFIED",
    };
  }

  private completedStages(value: unknown) {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const stage = item as Record<string, unknown>;
      if (stage.status !== "passed" && stage.conclusion !== "success") return [];
      const key = typeof stage.key === "string" ? stage.key : typeof stage.stage === "string" ? stage.stage : null;
      if (!key) return [];
      return [{ stage: key, label: typeof stage.label === "string" ? stage.label : key }];
    });
  }

  private excerpt(evidence: string, pattern?: RegExp) {
    const match = pattern ? evidence.match(pattern)?.[0] : null;
    return this.safe(match || evidence, 800);
  }

  private safe(value: string, limit: number) {
    return this.sanitizer.sanitize(value).replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit) || "No safe terminal evidence was available.";
  }
}
