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
import { MANAGED_DATABASE_RECONCILIATION_FAILURE } from "../managed-database-reconciliation.error";
import { failureContractFor } from "./failure-contract.catalog";
import { classifyFailureCode } from "../failure-ownership";

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

const externalRetry = (tool: string, rootCauseCode: string, summary: string, technicalReason: string, pattern: RegExp): Diagnosis => ({
  rootCauseCode, owner: "EXTERNAL_PROVIDER", provider: "network", affectedComponent: "External package registry", tool,
  summary, technicalReason, recommendedAction: "Retry the same immutable deployment after the proven registry or network outage clears.",
  remediationSteps: ["Review the bounded registry/provider evidence.", "Wait for the external registry or network path to recover.", "Retry the same immutable source without changing dependencies."],
  retryDecision: "SAFE_NOW", confidence: "DETERMINISTIC", evidencePattern: pattern,
});

@Injectable()
export class FailureDiagnosticService {
  constructor(private readonly sanitizer: LogSanitizerService) {}

  diagnose(input: DeploymentFailureDiagnosticInput): DeploymentFailureDiagnostic {
    const evidence = this.safe(input.safeEvidence || input.errorMessage || "No terminal evidence was available.", 12_000);
    const diagnosis = this.classify(input.terminalFailureCode, input.failureStage, evidence, input.failureOwner, input.externalProvider, input.managedDatabaseReconciliation);
    const owner = diagnosis.owner || input.failureOwner;
    const provider = owner === "EXTERNAL_PROVIDER" ? (diagnosis.provider || input.externalProvider || null) : null;
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

  private classify(
    terminalCode: string,
    stage: string,
    evidence: string,
    failureOwner: DeploymentFailureDiagnosticInput["failureOwner"],
    externalProvider: DeploymentFailureDiagnosticInput["externalProvider"],
    managedDatabase?: DeploymentFailureDiagnosticInput["managedDatabaseReconciliation"],
  ): Diagnosis {
    if (terminalCode === MANAGED_DATABASE_RECONCILIATION_FAILURE && managedDatabase) {
      return this.managedDatabaseDiagnosis(managedDatabase);
    }
    const authoritative = failureContractFor(terminalCode);
    const evidenceClassifiable = !authoritative || ["DG_APPLICATION_RUNTIME_FAILED", "DG_APPLICATION_STARTUP_FAILED", "DG_RAILPACK_BUILD_FAILED", "DG_ECS_STABILITY_FAILED", "DG_FAILURE_UNVERIFIED"].includes(terminalCode);
    if (authoritative && !evidenceClassifiable) return { ...authoritative, confidence: "DETERMINISTIC" };
    const managedUrlEvidence = evidence.match(/DG_MANAGED_DATABASE_URL_EVIDENCE[^\n]*\bsealedScheme=([a-z][a-z0-9+._-]*)\s+suppliedScheme=([a-z][a-z0-9+._-]*)/i);
    if (managedUrlEvidence && managedUrlEvidence[1].toLowerCase() !== managedUrlEvidence[2].toLowerCase() && /ModuleNotFoundError/i.test(evidence) && /sqlalchemy\/dialects\/(?:postgresql|mysql)\//i.test(evidence)) {
      return { ...failureContractFor("DG_MANAGED_DATABASE_DRIVER_CONTRACT_MISMATCH")!, confidence: "DETERMINISTIC", evidencePattern: /(?:sqlalchemy\/dialects\/(?:postgresql|mysql)\/[^\n]{0,300}|ModuleNotFoundError[^\n]{0,300}|DG_MANAGED_DATABASE_URL_EVIDENCE[^\n]{0,300})/i };
    }
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

    const registryOutage = /(?:(?:registry\.npmjs\.org|pypi\.org|files\.pythonhosted\.org|crates\.io|index\.crates\.io)[^\n]{0,240}(?:EAI_AGAIN|ETIMEDOUT|ECONNRESET|HTTP\s+(?:502|503|504)|(?:502|503|504)\s+(?:Bad Gateway|Service Unavailable|Gateway Timeout))|(?:EAI_AGAIN|ETIMEDOUT|ECONNRESET|HTTP\s+(?:502|503|504))[^\n]{0,240}(?:registry\.npmjs\.org|pypi\.org|files\.pythonhosted\.org|crates\.io|index\.crates\.io))/i;
    if (registryOutage.test(evidence)) return externalRetry("package-registry", "DG_PACKAGE_REGISTRY_PROVIDER_UNAVAILABLE", "The external package registry or network path is unavailable.", "A named public package registry and a provider-grade timeout, reset, DNS, or 5xx response are both present in the terminal evidence.", registryOutage);

    const nativeCapability = /(?:pg_config(?: executable)? (?:not found|is required|could not be found)|fatal error:\s*[^:\n]+\.h:\s*No such file or directory|gyp ERR! find (?:Python|make)|node-gyp[^\n]{0,180}(?:could not find|not found)(?:[^\n]{0,80})(?:compiler|python|make)|(?:cargo|rustc)[^\n]{0,220}(?:linker [`'\"]?(?:cc|gcc|clang)[`'\"]? not found|failed to find tool)|(?:C|C\+\+) compiler[^\n]{0,160}(?:not found|cannot create executables)|(?:gcc|g\+\+|clang|make): (?:command )?not found)/i;
    if (nativeCapability.test(evidence)) return repositoryFix("native-build", "DG_RAILPACK_NATIVE_BUILD_CAPABILITY_MISSING", evidence.match(/pg_config|node-gyp|gyp ERR!|cargo|rustc|gcc|g\+\+|clang|make/i)?.[0], "A native build capability is missing.", "Compiler, header, pg_config, node-gyp, or Cargo evidence proves that the repository build requires an undeclared Railpack system capability.", "Declare the required supported Railpack build capability for this service; keep dependency resolution in Railpack.", nativeCapability);

    const runtimeSharedLibrary = /(?:error while loading shared libraries:\s*[^\s:]+\.so(?:\.[0-9]+)*:\s*cannot open shared object file|(?:ImportError|OSError):\s*[^\n]*\.so(?:\.[0-9]+)*[^\n]*(?:cannot open shared object file|No such file or directory))/i;
    if (runtimeSharedLibrary.test(evidence)) return repositoryFix("runtime-loader", "DG_RUNTIME_SHARED_LIBRARY_MISSING", undefined, "A required runtime shared library is missing.", "The runtime loader named a missing .so library in the immutable application image.", "Declare the required supported Railpack deploy-time system capability for this service.", runtimeSharedLibrary);

    const runtimeVersion = /(?:EBADENGINE[^\n]{0,240}(?:required|wanted)[^\n]{0,160}(?:current|actual)|(?:requires|requires-python)\s+(?:Python|Node(?:\.js)?)\s*(?:>=|<=|==|>|<|\^|~)[^\n]{0,100}(?:but|current|running|installed)[^\n]{0,120}|Package ['\"][^'\"]+['\"] requires a different Python|Unsupported (?:Python|Node(?:\.js)?) version[^\n]{0,180}(?:required|current))/i;
    if (runtimeVersion.test(evidence)) return repositoryFix("runtime-version", "DG_RAILPACK_RUNTIME_VERSION_INCOMPATIBLE", evidence.match(/EBADENGINE|requires-python/i)?.[0]?.toUpperCase(), "The selected interpreter/runtime version is incompatible.", "Installer or runtime evidence states both the required and current interpreter/runtime constraints.", "Correct the service's supported Railpack runtime-version capability or repository version constraint.", runtimeVersion);

    if (/error TS\d{4}:|TypeScript compilation failed/i.test(evidence)) return repositoryFix("typescript", "DG_APPLICATION_COMPILATION_FAILED", evidence.match(/TS\d{4}/i)?.[0].toUpperCase(), "Application compilation failed.", "The TypeScript compiler reported a repository-owned source error.", "Correct the reported TypeScript source error.", /(?:error TS\d{4}:|TypeScript compilation failed)[^\n]{0,300}/i);
    if (/(?:ModuleNotFoundError|Cannot find module|Module not found: Error: Can't resolve)/i.test(evidence)) return repositoryFix(/ModuleNotFoundError/i.test(evidence) ? "python" : "javascript", "DG_APPLICATION_MODULE_MISSING", evidence.match(/ModuleNotFoundError|MODULE_NOT_FOUND/i)?.[0], "A required application module is missing.", "Application build or startup evidence identifies a missing repository dependency/module.", "Add or correct the missing declared module and its import.", /(?:ModuleNotFoundError|Cannot find module|Module not found)[^\n]{0,300}/i);
    if (/(?:npm|pnpm|yarn|bun) (?:run )?(?:build|compile)[^\n]{0,180}(?:failed|exit code [1-9]|ELIFECYCLE)/i.test(evidence)) return repositoryFix("application-build", "DG_APPLICATION_BUILD_SCRIPT_FAILED", undefined, "The application build command failed.", "The repository-owned build script returned a deterministic failure.", "Correct the application build script or source error.", /(?:npm|pnpm|yarn|bun)[^\n]{0,350}/i);
    if (/(?:Traceback \(most recent call last\)|uncaught exception|application failed to start|process exited with code [1-9])/i.test(evidence) && /(?:startup|runtime|health|application|server)/i.test(`${stage} ${evidence}`)) return repositoryFix(/Traceback/i.test(evidence) ? "python" : "application", "DG_APPLICATION_STARTUP_OR_RUNTIME_FAILED", undefined, "The application failed during startup or runtime.", "Application process evidence proves an application exception or non-zero exit.", "Correct the application startup/runtime error.", /(?:Traceback \(most recent call last\)|uncaught exception|application failed to start|process exited with code [1-9])[^\n]{0,300}/i);
    if (/application database (?:connection|authentication) failed/i.test(evidence)) return repositoryFix("application", "DG_APPLICATION_DATABASE_CONSUMPTION_FAILED", undefined, "The application could not consume its database configuration.", "Application-owned runtime evidence proves failure while consuming the supplied database contract.", "Correct the application database client configuration or usage.", /application database (?:connection|authentication) failed[^\n]{0,300}/i);
    if (/(?:static output directory|static artifact)[^\n]{0,160}(?:missing|not found|empty)/i.test(evidence)) return repositoryFix("application-build", "DG_STATIC_OUTPUT_MISSING", undefined, "The static application output is missing.", "The application build completed without the configured static output artifact.", "Correct the application static build/output configuration.", /(?:static output directory|static artifact)[^\n]{0,300}/i);

    if (terminalCode === "DG_ECS_STABILITY_FAILED") {
      const provenRepositoryFailure = failureOwner === "REPOSITORY_APPLICATION";
      const provenProviderFailure = failureOwner === "EXTERNAL_PROVIDER" && Boolean(externalProvider);
      return {
        rootCauseCode: "DG_ECS_SERVICE_STABILITY_FAILED", affectedComponent: "Amazon ECS service", summary: "The ECS service did not reach stable healthy state.",
        technicalReason: failureOwner === "UNVERIFIED"
          ? "The structured code proves the ECS stability boundary, but the available diagnostics do not prove who owns the underlying cause."
          : "Structured ECS diagnostics identified both the service stability boundary and its failure owner.",
        recommendedAction: provenRepositoryFailure
          ? "Correct the application failure identified by ECS diagnostics and deploy a new commit."
          : provenProviderFailure
            ? "Retry after the verified external-provider condition clears."
            : failureOwner === "DEPLOYGUARD_PLATFORM"
              ? "Resolve the verified DeployGuard platform condition before retrying."
              : "Review the service-scoped ECS diagnostics before choosing a recovery action.",
        remediationSteps: provenRepositoryFailure
          ? ["Review the service-scoped ECS diagnostics.", "Correct the application-owned failure.", "Commit and deploy the corrected source."]
          : ["Review the service-scoped ECS diagnostics.", "Resolve the proven platform or provider condition.", "Retry only after that condition changes."],
        retryDecision: provenRepositoryFailure ? "SAFE_AFTER_FIX" : provenProviderFailure ? "SAFE_NOW" : failureOwner === "DEPLOYGUARD_PLATFORM" ? "NOT_SAFE_YET" : "INSUFFICIENT_EVIDENCE",
        confidence: failureOwner === "UNVERIFIED" ? "UNVERIFIED" : "DETERMINISTIC",
      };
    }
    if (authoritative) return { ...authoritative, confidence: "DETERMINISTIC" };
    if (terminalCode === "DG_RAILPACK_BUILD_FAILED") return {
      rootCauseCode: "DG_RAILPACK_BUILD_FAILED", affectedComponent: "Railpack application build", summary: "The Railpack application build failed.",
      technicalReason: "The structured boundary proves the build failed, but the available evidence does not prove whether its underlying cause belongs to the repository, platform, or provider.",
      recommendedAction: "Review the sanitized build evidence before choosing a recovery action.", remediationSteps: ["Review the bounded Railpack build evidence.", "Do not retry or change source until the underlying cause is identified."],
      retryDecision: "INSUFFICIENT_EVIDENCE", confidence: "UNVERIFIED",
    };
    return {
      rootCauseCode: "DG_FAILURE_CAUSE_UNVERIFIED", affectedComponent: "Deployment operation", summary: "The deployment failed, but the specific cause is not verified.",
      technicalReason: "Terminal evidence was captured, but no authoritative structured code or sufficiently unique signature proves a more specific cause.",
      recommendedAction: "Review the relevant sanitized evidence or ask AI for evidence-bound assistance before deciding whether to retry.",
      remediationSteps: ["Review the relevant sanitized evidence.", "Use evidence-bound AI troubleshooting if useful.", "Do not assume retry is safe until the cause is understood."],
      retryDecision: "INSUFFICIENT_EVIDENCE", confidence: "UNVERIFIED",
    };
  }

  private managedDatabaseDiagnosis(reconciliation: NonNullable<DeploymentFailureDiagnosticInput["managedDatabaseReconciliation"]>): Diagnosis {
    const resetGuidance = reconciliation.resetAllowed && !reconciliation.recoveryAvailable
      ? "If no persistent database data must be retained, use the existing Reset & Deploy Fresh flow only after explicitly confirming its destructive fresh-generation semantics."
      : "Do not reset or delete managed database resources automatically.";
    const common = {
      owner: "DEPLOYGUARD_PLATFORM" as const,
      affectedComponent: "Managed database reconciliation",
      retryDecision: "NOT_SAFE_YET" as const,
      confidence: "DETERMINISTIC" as const,
    };
    switch (reconciliation.reconciliationState) {
      case "STALE_METADATA":
        return {
          ...common,
          rootCauseCode: "DG_MANAGED_DATABASE_STALE_METADATA",
          summary: "Stale managed database state blocks deployment.",
          technicalReason: "No verified persistent database exists, but DeployGuard-owned credentials, bindings, or Terraform state remain in the exact project/environment namespace.",
          recommendedAction: "Inspect the persisted managed-database reconciliation evidence before starting another deployment.",
          remediationSteps: ["Review the deterministic managed-database reconciliation evidence.", "Normal deployment is intentionally blocked until stale platform state is reconciled.", resetGuidance],
        };
      case "RECOVERABLE":
        return {
          ...common,
          rootCauseCode: "DG_MANAGED_DATABASE_RECOVERY_REQUIRED",
          summary: "Managed database recovery is required before deployment.",
          technicalReason: "Expected persistent storage is unavailable, but a verified recovery point exists.",
          recommendedAction: "Restore the managed database through the existing recovery path before deploying.",
          remediationSteps: ["Review the verified recovery evidence.", "Restore the managed database using the existing recovery path.", "Do not use a destructive reset while recovery evidence exists."],
        };
      case "DATA_LOST_RESET_REQUIRED":
        return {
          ...common,
          rootCauseCode: "DG_MANAGED_DATABASE_DATA_LOST_RESET_REQUIRED",
          summary: "Managed database data is unavailable and requires an explicit fresh reset.",
          technicalReason: "DeployGuard established that persistent data previously existed, current storage is unavailable, and no verified recovery point exists.",
          recommendedAction: "Keep normal deployment blocked until the data-loss condition is explicitly accepted.",
          remediationSteps: ["Review the deterministic data-loss evidence.", "Do not retry normal deployment.", resetGuidance],
        };
      case "IDENTITY_MIGRATION_REQUIRED":
        return {
          ...common,
          rootCauseCode: "DG_MANAGED_DATABASE_IDENTITY_MIGRATION_REQUIRED",
          summary: "Managed database identity reconciliation is required.",
          technicalReason: "Persistent storage exists, but its binding, access point, credentials, or Terraform identity does not match the expected platform-owned identity.",
          recommendedAction: "Reconcile or migrate the platform-managed database identity before deploying.",
          remediationSteps: ["Review the deterministic identity reconciliation evidence.", "Reconcile the platform-managed storage and binding identity.", "Do not change application-owned environment variables unless separate evidence proves an application configuration defect."],
        };
      default:
        return {
          ...common,
          rootCauseCode: "DG_MANAGED_DATABASE_RECONCILIATION_FAILED",
          summary: "Managed database reconciliation blocked deployment.",
          technicalReason: "DeployGuard rejected the managed database admission state before workflow dispatch.",
          recommendedAction: "Review the managed-database reconciliation evidence before retrying.",
          remediationSteps: ["Review the persisted managed-database reconciliation evidence.", "Resolve the platform-owned condition before deploying again."],
        };
    }
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

type PersistedFailureOperation = {
  id: string;
  commitSha?: string | null;
  currentStage?: string | null;
  failedAt?: Date | string | null;
  updatedAt?: Date | string | null;
  errorMessage?: string | null;
  failureCode?: string | null;
  failureServiceId?: string | null;
  metadata?: Record<string, unknown> | null;
};

/**
 * Reclassifies current recovery authority from immutable terminal facts. The
 * original metadata.failureDiagnostic remains untouched as historical audit
 * evidence and is only used for non-authoritative display context.
 */
export function currentFailureDiagnostic(operation: PersistedFailureOperation): DeploymentFailureDiagnostic | null {
  const metadata = operation.metadata || {};
  const historical = metadata.failureDiagnostic && typeof metadata.failureDiagnostic === "object"
    ? metadata.failureDiagnostic as Partial<DeploymentFailureDiagnostic>
    : null;
  const code = typeof operation.failureCode === "string" && operation.failureCode
    ? operation.failureCode
    : typeof historical?.terminalFailureCode === "string" ? historical.terminalFailureCode : null;
  if (!code) return null;
  const stage = typeof metadata.failedStage === "string" ? metadata.failedStage : operation.currentStage || "unknown";
  const safeEvidence = typeof metadata.safeLog === "string" ? metadata.safeLog : operation.errorMessage || `DG_FAILURE code=${code} stage=${stage}`;
  const ownership = classifyFailureCode(code, stage, safeEvidence, operation.failureServiceId || historical?.serviceId || null);
  const failedAtValue = operation.failedAt || operation.updatedAt || historical?.failedAt || new Date(0);
  const failedAt = failedAtValue instanceof Date ? failedAtValue : new Date(failedAtValue);
  const managedDatabase = metadata.managedDatabaseReconciliationFailure && typeof metadata.managedDatabaseReconciliationFailure === "object"
    ? metadata.managedDatabaseReconciliationFailure as DeploymentFailureDiagnosticInput["managedDatabaseReconciliation"]
    : undefined;
  return new FailureDiagnosticService(new LogSanitizerService()).diagnose({
    operationId: operation.id,
    deploymentAction: metadata.deploymentAction === "rollback" ? "rollback" : metadata.deploymentAction === "destroy" ? "destroy" : "deploy",
    sourceSha: operation.commitSha || historical?.sourceSha || null,
    failureStage: stage,
    terminalFailureCode: ownership.failureCode,
    failureOwner: ownership.failureOwner,
    externalProvider: ownership.externalProvider,
    serviceId: ownership.failureServiceId,
    serviceName: historical?.serviceName || null,
    errorMessage: operation.errorMessage,
    safeEvidence,
    evidenceSource: historical?.evidenceReferences?.[0]?.source || (metadata.dispatchState === "failed" ? "deployguard_dispatch" : "github_actions"),
    evidenceEventId: historical?.evidenceReferences?.[0]?.eventId || null,
    failedAt: Number.isNaN(failedAt.getTime()) ? new Date(0) : failedAt,
    workflowStages: metadata.workflowStages,
    managedDatabaseReconciliation: managedDatabase,
  });
}
