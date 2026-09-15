import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LogSanitizerService } from "../src/observability/log-sanitizer.service";
import { AiEvidencePreprocessorService } from "../src/ai-troubleshooting/ai-evidence-preprocessor.service";
import { currentFailureDiagnostic, FailureDiagnosticService } from "../src/projects/failure-diagnostics/failure-diagnostic.service";
import { DeploymentFailureDiagnosticInput, FailureRetryDecision } from "../src/projects/failure-diagnostics/failure-diagnostic.types";
import { classifyStructuredFailure } from "../src/projects/failure-ownership";
import { FAILURE_CONTRACT } from "../src/projects/failure-diagnostics/failure-contract.catalog";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";
import { MANAGED_DATABASE_RECONCILIATION_FAILURE, ManagedDatabaseReconciliationAdmissionError } from "../src/projects/managed-database-reconciliation.error";
import { ManagedDatabaseReconciliationState } from "../src/projects/managed-database-reconciliation";

const sanitizer = new LogSanitizerService();
const service = new FailureDiagnosticService(sanitizer);
const now = new Date("2026-01-02T03:04:05.000Z");
const serviceId = "11111111-1111-4111-8111-111111111111";

function diagnose(evidence: string, overrides: Partial<DeploymentFailureDiagnosticInput> = {}) {
  const stage = overrides.failureStage || "railpack_build";
  const terminalFailureCode = overrides.terminalFailureCode || "DG_RAILPACK_BUILD_FAILED";
  const marker = `DG_FAILURE code=${terminalFailureCode} stage=${stage}${overrides.serviceId ? ` serviceId=${overrides.serviceId}` : ""}`;
  const authority = classifyStructuredFailure(stage, evidence.includes("DG_FAILURE ") ? evidence : marker);
  const input: DeploymentFailureDiagnosticInput = {
    operationId: "22222222-2222-4222-8222-222222222222",
    deploymentAction: "deploy",
    sourceSha: "a".repeat(40),
    failureStage: stage,
    terminalFailureCode,
    failureOwner: authority.failureOwner,
    externalProvider: authority.externalProvider,
    serviceId: authority.failureServiceId,
    serviceName: overrides.serviceName,
    errorMessage: "Deployment failed.",
    safeEvidence: evidence,
    evidenceSource: "github_actions",
    evidenceEventId: "987654321",
    failedAt: now,
    workflowStages: [{ key: "checkout", label: "Checkout", status: "passed" }, { key: "railpack_build", status: "failed" }, { key: "publish", status: "pending" }],
    ...overrides,
  };
  if (input.failureOwner === undefined) input.failureOwner = authority.failureOwner;
  if (input.externalProvider === undefined) input.externalProvider = authority.externalProvider;
  if (input.serviceId === undefined) input.serviceId = authority.failureServiceId;
  return service.diagnose(input);
}

const cases: Array<{ name: string; evidence: string; root: string; tool?: string; code?: string; stage?: string; owner?: DeploymentFailureDiagnosticInput["failureOwner"]; provider?: DeploymentFailureDiagnosticInput["externalProvider"] }> = [
  { name: "npm dependency", evidence: "npm ERR! code ERESOLVE\nERESOLVE unable to resolve dependency tree", root: "DG_REPOSITORY_DEPENDENCY_RESOLUTION_FAILED", tool: "npm" },
  { name: "pnpm dependency", evidence: "ERR_PNPM_NO_MATCHING_VERSION No matching version found", root: "DG_REPOSITORY_DEPENDENCY_RESOLUTION_FAILED", tool: "pnpm" },
  { name: "Yarn dependency", evidence: "YN0002 package doesn't provide peer dependency", root: "DG_REPOSITORY_DEPENDENCY_RESOLUTION_FAILED", tool: "yarn" },
  { name: "Bun dependency", evidence: "bun install failed to resolve package not found", root: "DG_REPOSITORY_DEPENDENCY_RESOLUTION_FAILED", tool: "bun" },
  { name: "npm lock", evidence: "npm ci failed: package-lock is not in sync with package.json", root: "DG_REPOSITORY_LOCKFILE_OUTDATED", tool: "npm" },
  { name: "Yarn lock", evidence: "YN0028 The lockfile would have been modified by this install", root: "DG_REPOSITORY_LOCKFILE_OUTDATED", tool: "yarn" },
  { name: "Bun lock", evidence: "bun install frozen lockfile changed and failed", root: "DG_REPOSITORY_LOCKFILE_OUTDATED", tool: "bun" },
  { name: "pip", evidence: "ERROR: ResolutionImpossible: conflicting requirements", root: "DG_PYTHON_DEPENDENCY_RESOLUTION_FAILED", tool: "pip" },
  { name: "Poetry", evidence: "SolverProblemError: version solving failed in poetry", root: "DG_PYTHON_DEPENDENCY_RESOLUTION_FAILED", tool: "poetry" },
  { name: "uv", evidence: "uv failed to resolve: no solution found", root: "DG_PYTHON_DEPENDENCY_RESOLUTION_FAILED", tool: "uv" },
  { name: "PDM", evidence: "pdm: unable to find a resolution", root: "DG_PYTHON_DEPENDENCY_RESOLUTION_FAILED", tool: "pdm" },
  { name: "Pipenv", evidence: "pipenv locking failed", root: "DG_PYTHON_DEPENDENCY_RESOLUTION_FAILED", tool: "pipenv" },
  { name: "TypeScript", evidence: "src/app.ts(3,2): error TS2322: Type string is not assignable", root: "DG_APPLICATION_COMPILATION_FAILED", tool: "typescript" },
  { name: "missing JS module", evidence: "Module not found: Error: Can't resolve './missing'", root: "DG_APPLICATION_MODULE_MISSING", tool: "javascript" },
  { name: "missing Python module", evidence: "ModuleNotFoundError: No module named 'missing'", root: "DG_APPLICATION_MODULE_MISSING", tool: "python" },
  { name: "build script", evidence: "pnpm run build failed with exit code 1", root: "DG_APPLICATION_BUILD_SCRIPT_FAILED", tool: "application-build" },
  { name: "static output", evidence: "static output directory not found", root: "DG_STATIC_OUTPUT_MISSING", tool: "application-build" },
  { name: "runtime", evidence: "application failed to start; process exited with code 1", root: "DG_APPLICATION_STARTUP_OR_RUNTIME_FAILED", tool: "application", stage: "application_runtime", code: "DG_APPLICATION_RUNTIME_FAILED", owner: "REPOSITORY_APPLICATION" },
  { name: "database consumption", evidence: "application database connection failed", root: "DG_APPLICATION_DATABASE_CONSUMPTION_FAILED", tool: "application", stage: "application_runtime", code: "DG_APPLICATION_RUNTIME_FAILED", owner: "REPOSITORY_APPLICATION" },
];

for (const item of cases) {
  const caseOverrides: Partial<DeploymentFailureDiagnosticInput> = {};
  if (item.stage) caseOverrides.failureStage = item.stage;
  if (item.code) caseOverrides.terminalFailureCode = item.code;
  if (item.owner) caseOverrides.failureOwner = item.owner;
  if (item.provider !== undefined) caseOverrides.externalProvider = item.provider;
  const result = diagnose(item.evidence, caseOverrides);
  assert.equal(result.rootCauseCode, item.root, item.name);
  assert.equal(result.tool, item.tool, item.name);
  assert.equal(result.failureOwner, "REPOSITORY_APPLICATION", item.name);
  assert.equal(result.confidence, "DETERMINISTIC", item.name);
  assert.equal(result.retryDecision, "SAFE_AFTER_FIX", item.name);
}

const runtimeSecretFailure = diagnose("AWS Secrets Manager runtime configuration failed.", {
  failureStage: "runtime_secret_materialization",
  terminalFailureCode: "DG_RUNTIME_SECRET_MATERIALIZATION_FAILED",
  failureOwner: "EXTERNAL_PROVIDER",
  externalProvider: "aws",
});
assert.equal(runtimeSecretFailure.rootCauseCode, "DG_RUNTIME_SECRET_MATERIALIZATION_FAILED");
assert.equal(runtimeSecretFailure.failureOwner, "EXTERNAL_PROVIDER");
assert.equal(runtimeSecretFailure.externalProvider, "aws");

const publicReachabilityFailure = diagnose("DG_FAILURE code=DG_PUBLIC_REACHABILITY_FAILED stage=public_health", {
  failureStage: "public_health",
  terminalFailureCode: "DG_PUBLIC_REACHABILITY_FAILED",
  failureOwner: "EXTERNAL_PROVIDER",
  externalProvider: "aws",
  serviceId,
  serviceName: "web",
});
assert.equal(publicReachabilityFailure.terminalFailureCode, "DG_PUBLIC_REACHABILITY_FAILED");
assert.equal(publicReachabilityFailure.rootCauseCode, "DG_PUBLIC_REACHABILITY_FAILED");
assert.equal(publicReachabilityFailure.failureOwner, "EXTERNAL_PROVIDER");
assert.equal(publicReachabilityFailure.externalProvider, "aws");
assert.equal(publicReachabilityFailure.retryDecision, "SAFE_NOW");
assert.equal(publicReachabilityFailure.confidence, "DETERMINISTIC");

const applicationBindingFailure = diagnose("DG_FAILURE serviceId=11111111-1111-4111-8111-111111111111 code=DG_APPLICATION_EXTERNAL_BINDING_FAILED stage=application_runtime", {
  failureStage: "application_runtime",
  terminalFailureCode: "DG_APPLICATION_EXTERNAL_BINDING_FAILED",
  failureOwner: "REPOSITORY_APPLICATION",
  externalProvider: null,
  serviceId,
  serviceName: "web",
});
assert.equal(applicationBindingFailure.rootCauseCode, "DG_APPLICATION_EXTERNAL_BINDING_FAILED");
assert.equal(applicationBindingFailure.failureOwner, "REPOSITORY_APPLICATION");
assert.equal(applicationBindingFailure.externalProvider, null);
assert.equal(applicationBindingFailure.retryDecision, "SAFE_AFTER_FIX");
assert.equal(applicationBindingFailure.confidence, "DETERMINISTIC");

const platformDriverMismatch = diagnose([
  "File /app/.venv/lib/python/site-packages/sqlalchemy/dialects/postgresql/psycopg2.py, line 690, in import_dbapi",
  "ModuleNotFoundError: No module named 'psycopg2'",
  `DG_MANAGED_DATABASE_URL_EVIDENCE serviceId=${serviceId} sealedScheme=postgresql+psycopg suppliedScheme=postgresql`,
].join("\n"), { failureStage: "application_runtime", terminalFailureCode: "DG_APPLICATION_STARTUP_FAILED", failureOwner: "REPOSITORY_APPLICATION", serviceId });
assert.equal(platformDriverMismatch.rootCauseCode, "DG_MANAGED_DATABASE_DRIVER_CONTRACT_MISMATCH");
assert.equal(platformDriverMismatch.failureOwner, "DEPLOYGUARD_PLATFORM");
assert.equal(platformDriverMismatch.retryDecision, "NOT_SAFE_YET");

const repositoryDeclaredDriverMissing = diagnose([
  "File /app/.venv/lib/python/site-packages/sqlalchemy/dialects/postgresql/psycopg.py, line 418, in import_dbapi",
  "ModuleNotFoundError: No module named 'psycopg'",
  `DG_MANAGED_DATABASE_URL_EVIDENCE serviceId=${serviceId} sealedScheme=postgresql+psycopg suppliedScheme=postgresql+psycopg`,
].join("\n"), { failureStage: "application_runtime", terminalFailureCode: "DG_APPLICATION_STARTUP_FAILED", failureOwner: "REPOSITORY_APPLICATION", serviceId });
assert.equal(repositoryDeclaredDriverMissing.rootCauseCode, "DG_APPLICATION_MODULE_MISSING");
assert.equal(repositoryDeclaredDriverMissing.failureOwner, "REPOSITORY_APPLICATION");
assert.equal(repositoryDeclaredDriverMissing.retryDecision, "SAFE_AFTER_FIX");

for (const [code, contract] of Object.entries(FAILURE_CONTRACT)) {
  const result = diagnose(`DG_FAILURE code=${code} stage=contract_audit`, { terminalFailureCode: code, failureStage: "contract_audit" });
  assert.equal(result.terminalFailureCode, code, `${code} retains terminal identity`);
  assert.equal(result.failureOwner, contract.owner, `${code} owner`);
  assert.equal(result.externalProvider, contract.provider, `${code} provider`);
  assert.equal(result.rootCauseCode, contract.rootCauseCode, `${code} diagnosis`);
  assert.equal(result.retryDecision, contract.retryDecision, `${code} retry decision`);
  assert.equal(result.recommendedAction, contract.recommendedAction, `${code} recovery action`);
  assert.equal(result.confidence, "DETERMINISTIC", `${code} confidence`);
  assert.notEqual(result.rootCauseCode, "DG_FAILURE_CAUSE_UNVERIFIED", `${code} must not fall through`);
}

const repositoryRoot = join(__dirname, "..", "..");
const executableFailureSources = [
  ".github/workflows/deployguard-reusable.yml",
  "infrastructure/railpack-runtime/verify-runtime.sh",
  "infrastructure/railpack-runtime/register-release-task-definitions.sh",
  "infrastructure/railpack-runtime/build-release-result.sh",
].map((path) => readFileSync(join(repositoryRoot, path), "utf8")).join("\n");
const literalEmittedCodes = new Set([...executableFailureSources.matchAll(/\bcode=(DG_[A-Z0-9_]+)|\b(?:runtime_failure|managed_database_failure)\s+"[^"\n]+"\s+(DG_[A-Z0-9_]+)/g)].map((match) => match[1] || match[2]));
const evidenceDependentCodes = new Set(["DG_RAILPACK_BUILD_FAILED", "DG_ECS_STABILITY_FAILED"]);
for (const code of literalEmittedCodes) {
  assert.ok(code in FAILURE_CONTRACT || evidenceDependentCodes.has(code), `${code} is emitted by executable workflow/runtime code but absent from the failure contract`);
}

const pnpm = diagnose([
  "DG_FAILURE code=DG_RAILPACK_BUILD_FAILED stage=railpack_build serviceId=11111111-1111-4111-8111-111111111111",
  "ERR_PNPM_OUTDATED_LOCKFILE Cannot install with frozen-lockfile because pnpm-lock.yaml is not up to date",
  "packages/client/package.json next=16.1.5 while lockfile next=16.0.10",
  "open /var/lib/docker/tmp/build/repositories: no such file or directory",
].join("\n"), { serviceId, serviceName: "client" });
assert.equal(pnpm.terminalFailureCode, "DG_RAILPACK_BUILD_FAILED");
assert.equal(pnpm.rootCauseCode, "DG_REPOSITORY_LOCKFILE_OUTDATED");
assert.equal(pnpm.toolErrorCode, "ERR_PNPM_OUTDATED_LOCKFILE");
assert.equal(pnpm.serviceId, serviceId);
assert.equal(pnpm.serviceName, "client");
assert.match(pnpm.affectedComponent, /^client/);
assert.match(pnpm.technicalReason, /packages\/client\/package\.json requires next 16\.1\.5 while pnpm-lock\.yaml records 16\.0\.10/);
assert.doesNotMatch(pnpm.evidenceReferences[0].excerpt, /docker\/tmp/i, "secondary Docker fallout must not replace the causal pnpm evidence");
assert.deepEqual(pnpm.completedStages, [{ stage: "checkout", label: "Checkout" }]);

const railpackEvidenceCases: Array<[string, string, DeploymentFailureDiagnosticInput["failureOwner"], DeploymentFailureDiagnosticInput["externalProvider"], FailureRetryDecision]> = [
  ["checking for pg_config... not found\nerror: pg_config executable not found", "DG_RAILPACK_NATIVE_BUILD_CAPABILITY_MISSING", "REPOSITORY_APPLICATION", null, "SAFE_AFTER_FIX"],
  ["gyp ERR! find Python Python is not set from command line or npm configuration", "DG_RAILPACK_NATIVE_BUILD_CAPABILITY_MISSING", "REPOSITORY_APPLICATION", null, "SAFE_AFTER_FIX"],
  ["cargo: error: linker `cc` not found", "DG_RAILPACK_NATIVE_BUILD_CAPABILITY_MISSING", "REPOSITORY_APPLICATION", null, "SAFE_AFTER_FIX"],
  ["ImportError: libpq.so.5: cannot open shared object file: No such file or directory", "DG_RUNTIME_SHARED_LIBRARY_MISSING", "REPOSITORY_APPLICATION", null, "SAFE_AFTER_FIX"],
  ["npm ERR! code EBADENGINE\nnpm ERR! required: { node: '>=22' } current: { node: '20.19.0' }", "DG_RAILPACK_RUNTIME_VERSION_INCOMPATIBLE", "REPOSITORY_APPLICATION", null, "SAFE_AFTER_FIX"],
  ["GET https://registry.npmjs.org/example failed: ETIMEDOUT", "DG_PACKAGE_REGISTRY_PROVIDER_UNAVAILABLE", "EXTERNAL_PROVIDER", "network", "SAFE_NOW"],
];
for (const [evidence, rootCauseCode, owner, provider, retryDecision] of railpackEvidenceCases) {
  const result = diagnose(evidence, { terminalFailureCode: "DG_RAILPACK_BUILD_FAILED", failureStage: rootCauseCode === "DG_RUNTIME_SHARED_LIBRARY_MISSING" ? "application_runtime" : "railpack_build" });
  assert.equal(result.rootCauseCode, rootCauseCode);
  assert.equal(result.failureOwner, owner);
  assert.equal(result.externalProvider, provider);
  assert.equal(result.retryDecision, retryDecision);
  assert.equal(result.confidence, "DETERMINISTIC");
}
const ambiguousNative = diagnose("node-gyp exited with code 1 after compiling addon.cc", { terminalFailureCode: "DG_RAILPACK_BUILD_FAILED", failureStage: "railpack_build" });
assert.equal(ambiguousNative.rootCauseCode, "DG_RAILPACK_BUILD_FAILED", "native tool presence without a missing-capability signature remains ambiguous");
assert.equal(ambiguousNative.failureOwner, "UNVERIFIED");
assert.equal(ambiguousNative.confidence, "UNVERIFIED");
const startupSharedLibrary = diagnose("error while loading shared libraries: libssl.so.3: cannot open shared object file: No such file or directory", { terminalFailureCode: "DG_APPLICATION_STARTUP_FAILED", failureStage: "application_runtime" });
assert.equal(startupSharedLibrary.rootCauseCode, "DG_RUNTIME_SHARED_LIBRARY_MISSING", "runtime loader evidence refines the startup boundary without changing its terminal identity");
assert.equal(startupSharedLibrary.terminalFailureCode, "DG_APPLICATION_STARTUP_FAILED");

const structuredCases: Array<[string, string, DeploymentFailureDiagnosticInput["failureOwner"], DeploymentFailureDiagnosticInput["externalProvider"], string]> = [
  ["DG_DEPLOYMENT_INPUT_REQUIRED", "deployment_requirement_admission", "DEPLOYGUARD_PLATFORM", null, "DG_CONFIGURATION_INPUT_REQUIRED"],
  ["DG_DEPLOYMENT_REQUIREMENTS_BLOCKED", "deployment_requirement_admission", "DEPLOYGUARD_PLATFORM", null, "DG_CONFIGURATION_ADMISSION_BLOCKED"],
  ["DG_SERVICE_PORT_CONFLICT", "service_port_resolution", "REPOSITORY_APPLICATION", null, "DG_APPLICATION_PORT_CONFLICT"],
  ["DG_MANAGED_DATABASE_READINESS_FAILED", "database_readiness", "DEPLOYGUARD_PLATFORM", null, "DG_MANAGED_DATABASE_PLATFORM_READINESS_FAILED"],
  ["DG_MANAGED_MYSQL_GRANT_RECONCILIATION_FAILED", "database_grants", "DEPLOYGUARD_PLATFORM", null, "DG_MANAGED_MYSQL_GRANT_RECONCILIATION_FAILED"],
  ["DG_RAILPACK_PREREQUISITE_FAILED", "railpack_setup", "EXTERNAL_PROVIDER", "railpack", "DG_RAILPACK_PROVIDER_PREREQUISITE_FAILED"],
  ["DG_RAILPACK_CAPABILITY_INVALID", "railpack_capability_admission", "REPOSITORY_APPLICATION", null, "DG_RAILPACK_CAPABILITY_INVALID"],
  ["DG_RAILPACK_EXECUTION_OVERRIDE_REJECTED", "railpack_capability_admission", "REPOSITORY_APPLICATION", null, "DG_RAILPACK_EXECUTION_OVERRIDE_REJECTED"],
  ["DG_RAILPACK_CAPABILITY_FORWARDING_FAILED", "railpack_build", "DEPLOYGUARD_PLATFORM", null, "DG_RAILPACK_CAPABILITY_FORWARDING_FAILED"],
  ["DG_TRIVY_POLICY_BLOCKED", "trivy_scan", "REPOSITORY_APPLICATION", null, "DG_TRIVY_POLICY_BLOCKED"],
  ["DG_TRIVY_SCAN_FAILED", "trivy_scan", "DEPLOYGUARD_PLATFORM", null, "DG_TRIVY_SCAN_FAILED"],
  ["DG_RAILPACK_INTERNAL_FAILURE", "railpack_build", "EXTERNAL_PROVIDER", "railpack", "DG_RAILPACK_INTERNAL_FAILURE"],
  ["DG_DOCKER_FALLBACK_UNSUPPORTED", "docker_fallback_selection", "DEPLOYGUARD_PLATFORM", null, "DG_DOCKER_FALLBACK_UNSUPPORTED"],
  ["DG_DOCKER_FALLBACK_CONTRACT_INVALID", "docker_fallback_selection", "DEPLOYGUARD_PLATFORM", null, "DG_DOCKER_FALLBACK_CONTRACT_INVALID"],
  ["DG_DOCKER_FALLBACK_TEMPLATE_INTEGRITY_FAILED", "docker_fallback_selection", "DEPLOYGUARD_PLATFORM", null, "DG_DOCKER_FALLBACK_TEMPLATE_INTEGRITY_FAILED"],
  ["DG_DOCKER_FALLBACK_ALREADY_ATTEMPTED", "docker_fallback_selection", "DEPLOYGUARD_PLATFORM", null, "DG_DOCKER_FALLBACK_ALREADY_ATTEMPTED"],
  ["DG_GITHUB_PROVIDER_FAILED", "workflow_dispatch", "EXTERNAL_PROVIDER", "github", "DG_GITHUB_PROVIDER_OPERATION_FAILED"],
  ["DG_AWS_PROVIDER_FAILED", "aws_provider", "EXTERNAL_PROVIDER", "aws", "DG_AWS_PROVIDER_FAILED"],
  ["DG_TERRAFORM_VALIDATE_FAILED", "terraform_validate", "DEPLOYGUARD_PLATFORM", null, "DG_TERRAFORM_VALIDATE_FAILED"],
  ["DG_TERRAFORM_APPLY_FAILED", "terraform_apply", "EXTERNAL_PROVIDER", "aws", "DG_AWS_TERRAFORM_APPLY_FAILED"],
  ["DG_ECR_PUBLISH_FAILED", "ecr_publish", "EXTERNAL_PROVIDER", "aws", "DG_AWS_ECR_PUBLICATION_FAILED"],
  ["DG_ECS_STABILITY_FAILED", "ecs_stability", "UNVERIFIED", null, "DG_ECS_SERVICE_STABILITY_FAILED"],
];
for (const [code, stage, owner, provider, root] of structuredCases) {
  const result = diagnose(`DG_FAILURE code=${code} stage=${stage}`, { terminalFailureCode: code, failureStage: stage, failureOwner: owner, externalProvider: provider });
  assert.equal(result.rootCauseCode, root, code);
  assert.equal(result.failureOwner, owner, `${code} owner must remain authoritative`);
  assert.equal(result.externalProvider, provider, `${code} provider must remain authoritative`);
  if (code === "DG_ECS_STABILITY_FAILED") {
    assert.equal(result.confidence, "UNVERIFIED", "a stability boundary without causal diagnostics remains explicitly unverified");
    assert.equal(result.retryDecision, "INSUFFICIENT_EVIDENCE", "ambiguous ECS stability evidence cannot expose recovery");
  }
}

const repositoryEcsFailure = diagnose('DG_ECS_DIAGNOSTICS {"containerExitCode":1,"stoppedTaskReason":"Essential container exited"}\nDG_FAILURE code=DG_ECS_STABILITY_FAILED stage=ecs_stability', {
  terminalFailureCode: "DG_ECS_STABILITY_FAILED",
  failureStage: "ecs_stability",
});
assert.equal(repositoryEcsFailure.failureOwner, "REPOSITORY_APPLICATION");
assert.equal(repositoryEcsFailure.confidence, "DETERMINISTIC");
assert.equal(repositoryEcsFailure.retryDecision, "SAFE_AFTER_FIX");

const managedDatabaseFailure = (reconciliationState: ManagedDatabaseReconciliationState.STALE_METADATA | ManagedDatabaseReconciliationState.RECOVERABLE | ManagedDatabaseReconciliationState.DATA_LOST_RESET_REQUIRED | ManagedDatabaseReconciliationState.IDENTITY_MIGRATION_REQUIRED, overrides: Record<string, unknown> = {}) => ({
  reconciliationState,
  deploymentAllowed: false,
  resetAllowed: reconciliationState === "STALE_METADATA" || reconciliationState === "DATA_LOST_RESET_REQUIRED",
  recoveryAvailable: reconciliationState === "RECOVERABLE",
  engine: "postgres" as const,
  attachedServiceId: serviceId,
  environment: "dev",
  persistentPreviouslyEstablished: reconciliationState !== "STALE_METADATA",
  currentPersistentStoragePresent: reconciliationState === "IDENTITY_MIGRATION_REQUIRED",
  verifiedRecoveryEvidence: reconciliationState === "RECOVERABLE",
  evidence: { managed: true, persistenceEnabled: true, expectedStorageIdentity: reconciliationState !== "STALE_METADATA", bindingStatus: "ready", currentFileSystemPresent: reconciliationState === "IDENTITY_MIGRATION_REQUIRED", accessPointPresent: reconciliationState === "IDENTITY_MIGRATION_REQUIRED", passwordSecretPresent: reconciliationState === "STALE_METADATA", urlSecretPresent: reconciliationState === "STALE_METADATA", terraformDatabaseAddressCount: reconciliationState === "STALE_METADATA" ? 1 : 0, verifiedRecoveryEvidence: reconciliationState === "RECOVERABLE" },
  ...overrides,
});
const managedDatabaseCases: Array<[ManagedDatabaseReconciliationState.STALE_METADATA | ManagedDatabaseReconciliationState.RECOVERABLE | ManagedDatabaseReconciliationState.DATA_LOST_RESET_REQUIRED | ManagedDatabaseReconciliationState.IDENTITY_MIGRATION_REQUIRED, string, RegExp, RegExp]> = [
  [ManagedDatabaseReconciliationState.STALE_METADATA, "DG_MANAGED_DATABASE_STALE_METADATA", /Reset & Deploy Fresh/, /normal deployment is intentionally blocked/i],
  [ManagedDatabaseReconciliationState.RECOVERABLE, "DG_MANAGED_DATABASE_RECOVERY_REQUIRED", /Restore the managed database/, /Do not use a destructive reset/],
  [ManagedDatabaseReconciliationState.DATA_LOST_RESET_REQUIRED, "DG_MANAGED_DATABASE_DATA_LOST_RESET_REQUIRED", /Reset & Deploy Fresh/, /Do not retry normal deployment/],
  [ManagedDatabaseReconciliationState.IDENTITY_MIGRATION_REQUIRED, "DG_MANAGED_DATABASE_IDENTITY_MIGRATION_REQUIRED", /Reconcile or migrate/, /Do not change application-owned environment variables/],
];
for (const [state, rootCauseCode, action, remediation] of managedDatabaseCases) {
  const result = diagnose("No persistent database was verified, but stale database credentials, binding metadata, or Terraform state remains.", {
    failureStage: "managed_database_reconciliation",
    terminalFailureCode: MANAGED_DATABASE_RECONCILIATION_FAILURE,
    failureOwner: "DEPLOYGUARD_PLATFORM",
    externalProvider: null,
    serviceId,
    managedDatabaseReconciliation: managedDatabaseFailure(state),
  });
  assert.equal(result.rootCauseCode, rootCauseCode, `${state} has an authoritative cause`);
  assert.equal(result.failureOwner, "DEPLOYGUARD_PLATFORM");
  assert.equal(result.failureStage, "managed_database_reconciliation");
  assert.equal(result.confidence, "DETERMINISTIC");
  assert.equal(result.retryDecision, "NOT_SAFE_YET");
  assert.match(`${result.recommendedAction} ${result.remediationSteps.join(" ")}`, action);
  assert.match(result.remediationSteps.join(" "), remediation);
  assert.doesNotMatch(JSON.stringify(result), /DG_FAILURE_CAUSE_UNVERIFIED|password=|super-secret-value/);
}
for (const engine of ["postgres", "mysql", "mongodb"] as const) {
  const result = diagnose("managed database reconciliation blocked", {
    failureStage: "managed_database_reconciliation",
    terminalFailureCode: MANAGED_DATABASE_RECONCILIATION_FAILURE,
    failureOwner: "DEPLOYGUARD_PLATFORM",
    externalProvider: null,
    managedDatabaseReconciliation: managedDatabaseFailure(ManagedDatabaseReconciliationState.STALE_METADATA, { engine }),
  });
  assert.equal(result.rootCauseCode, "DG_MANAGED_DATABASE_STALE_METADATA", `${engine} uses the same platform reconciliation authority`);
}

for (const action of ["deploy", "rollback", "destroy"] as const) {
  const result = diagnose("ambiguous terminal failure", { deploymentAction: action });
  assert.equal(result.deploymentAction, action);
  assert.equal(result.rootCauseCode, "DG_RAILPACK_BUILD_FAILED", "a known umbrella code retains its verified boundary without inventing an underlying cause");
  assert.equal(result.confidence, "UNVERIFIED");
  assert.equal(result.retryDecision, "INSUFFICIENT_EVIDENCE");
}
const redeploy = diagnose("ambiguous redeploy terminal failure", { deploymentAction: "deploy" });
assert.equal(redeploy.deploymentAction, "deploy", "redeploy uses the frozen deploy action contract");

const unknown = diagnose("command returned a non-zero result with no specific causal evidence", { terminalFailureCode: "DG_UNKNOWN_TERMINAL_FAILURE" });
assert.equal(unknown.rootCauseCode, "DG_FAILURE_CAUSE_UNVERIFIED");
assert.equal(unknown.failureOwner, "UNVERIFIED");
assert.equal(unknown.retryDecision, "INSUFFICIENT_EVIDENCE");
assert.equal(unknown.confidence, "UNVERIFIED");
assert.ok(unknown.evidenceReferences[0].excerpt.length > 0);
const unknownRuntime = diagnose("container stopped for an unknown reason", { failureStage: "application_runtime", terminalFailureCode: "DG_FAILURE_UNVERIFIED" });
assert.equal(unknownRuntime.rootCauseCode, "DG_FAILURE_CAUSE_UNVERIFIED");
const unknownFallback = diagnose("certified Docker build returned a non-zero result", { failureStage: "docker_fallback_build", terminalFailureCode: "DG_DOCKER_FALLBACK_BUILD_FAILED" });
assert.equal(unknownFallback.rootCauseCode, "DG_DOCKER_FALLBACK_BUILD_FAILED");
assert.equal(unknownFallback.failureOwner, "UNVERIFIED");
assert.equal(unknownFallback.retryDecision, "INSUFFICIENT_EVIDENCE");

const historicalMetadata: Record<string, unknown> = {
  executionEngine: "railpack",
  deploymentAction: "deploy",
  failedStage: "application_runtime",
  safeLog: `DG_FAILURE serviceId=${serviceId} code=DG_APPLICATION_EXTERNAL_BINDING_FAILED stage=application_runtime`,
  failureDiagnostic: { ...unknown, terminalFailureCode: "DG_APPLICATION_EXTERNAL_BINDING_FAILED" },
};
const immutableAuditSnapshot = JSON.stringify(historicalMetadata.failureDiagnostic);
const currentRecovery = currentFailureDiagnostic({
  id: unknown.operationId,
  commitSha: "f".repeat(40),
  currentStage: "application_runtime",
  failedAt: now,
  failureCode: "DG_APPLICATION_EXTERNAL_BINDING_FAILED",
  failureServiceId: serviceId,
  metadata: historicalMetadata,
});
assert.equal(currentRecovery?.retryDecision, "SAFE_AFTER_FIX", "current recovery uses the current deterministic contract");
assert.equal(currentRecovery?.rootCauseCode, "DG_APPLICATION_EXTERNAL_BINDING_FAILED");
assert.equal(JSON.stringify(historicalMetadata.failureDiagnostic), immutableAuditSnapshot, "historical persisted diagnosis remains byte-for-byte unchanged");

const retainedOwner = diagnose("ambiguous detail", { failureOwner: "DEPLOYGUARD_PLATFORM", terminalFailureCode: "DG_FAILURE_UNVERIFIED" });
assert.equal(retainedOwner.failureOwner, "DEPLOYGUARD_PLATFORM", "unknown cause must retain proven owner");

const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456 Authorization: Bearer abcdefghijkl.mnopqrstuv.wxyz123456 password=super-secret-value";
const redacted = diagnose(secret);
const persisted = JSON.stringify(redacted);
assert.doesNotMatch(persisted, /super-secret-value|abcdefghijklmnopqrstuvwxyz123456|abcdefghijkl\.mnopqrstuv\.wxyz123456/);

const preprocessor = new AiEvidencePreprocessorService(sanitizer);
const evidence = preprocessor.preprocess([{ source: "deployguard_diagnosis", stage: pnpm.failureStage, eventId: pnpm.operationId, text: JSON.stringify(pnpm) }]);
const context = { problemType: "FAILED_DEPLOYMENT", failureOwner: pnpm.failureOwner, rootCauseCode: pnpm.rootCauseCode, retryDecision: pnpm.retryDecision, failureDiagnostic: pnpm };
const fallback = preprocessor.fallback(context, evidence);
assert.equal(fallback.rootCauseCode, pnpm.rootCauseCode);
assert.equal(fallback.retryRecommendation.decision, pnpm.retryDecision);
const conflicting = {
  ...fallback,
  rootCauseCode: "DG_INVENTED_CAUSE",
  likelyResponsibility: "EXTERNAL_PROVIDER",
  retryRecommendation: { decision: "SAFE_NOW", reason: "invented" },
  evidenceReferences: evidence.map((item) => ({ source: item.source, stage: item.stage, eventId: item.eventId })),
};
assert.equal(preprocessor.validate(conflicting, evidence, context), null, "AI must not override deterministic diagnosis");

async function verifyCentralPersistenceAndApi() {
  const deployment = Object.create(RailpackDeploymentService.prototype) as any;
  let saves = 0;
  deployment.sanitizer = sanitizer;
  deployment.failureDiagnostics = service;
  deployment.runs = { save: async (value: unknown) => { saves += 1; return value; } };
  const operation: any = {
    id: "33333333-3333-4333-8333-333333333333", commitSha: "b".repeat(40), metadata: { executionEngine: "railpack", deploymentAction: "deploy", attempt: 1 },
    failureOwner: null, externalProvider: null, failureCode: null, failureServiceId: null, githubWorkflowRunId: "123", createdAt: now,
  };
  await deployment.captureTerminalFailure(operation, {
    stage: "railpack_build", message: "Build failed", safeEvidence: "ERR_PNPM_OUTDATED_LOCKFILE pnpm-lock.yaml is not up to date",
    owner: "UNVERIFIED", provider: null, code: "DG_RAILPACK_BUILD_FAILED", serviceId: null, evidenceSource: "github_actions",
  });
  assert.equal(saves, 1, "central intake persists exactly once");
  assert.equal(operation.metadata.failureDiagnostic.rootCauseCode, "DG_REPOSITORY_LOCKFILE_OUTDATED");
  const api = deployment.presentOperation(operation);
  assert.equal(api.diagnosis.rootCauseCode, "DG_REPOSITORY_LOCKFILE_OUTDATED", "deployment details API exposes structured diagnosis");

  const databaseOperation: any = {
    id: "44444444-4444-4444-8444-444444444444", commitSha: "c".repeat(40), metadata: { executionEngine: "railpack", deploymentAction: "deploy", attempt: 1 },
    failureOwner: null, externalProvider: null, failureCode: null, failureServiceId: null, githubWorkflowRunId: null, createdAt: now,
  };
  const staleReport: any = {
    state: ManagedDatabaseReconciliationState.STALE_METADATA, deploymentAllowed: false, resetAllowed: true, recoveryAvailable: false,
    title: "Stale managed database state", message: "No persistent database was verified, but stale database credentials remain.",
    engine: "postgres", attachedServiceId: serviceId, tierUpdatedAt: now.toISOString(), identity: { environment: "dev", activeGenerationId: null },
    evidence: { managed: true, persistenceEnabled: true, expectedStorageIdentity: false, bindingStatus: null, bindingFileSystemId: null, bindingAccessPointId: null, currentFileSystem: null, accessPoint: null, passwordSecretPresent: true, urlSecretPresent: true, terraformDatabaseAddresses: ["aws_efs_file_system.database"], usableRecoveryPointArn: null },
  };
  const dispatchFailure = deployment.dispatchFailure(new ManagedDatabaseReconciliationAdmissionError(staleReport), "service_port_resolution");
  assert.equal(dispatchFailure.stage, "managed_database_reconciliation", "typed managed-database evidence overrides a stale previous stage");
  await deployment.captureTerminalFailure(databaseOperation, {
    stage: dispatchFailure.stage, message: dispatchFailure.message, safeEvidence: dispatchFailure.message,
    owner: dispatchFailure.ownership.failureOwner, provider: dispatchFailure.ownership.externalProvider,
    code: dispatchFailure.ownership.failureCode, serviceId: dispatchFailure.ownership.failureServiceId,
    evidenceSource: "deployguard_dispatch", managedDatabaseReconciliation: dispatchFailure.managedDatabaseReconciliation,
    metadata: { dispatchState: "failed", managedDatabaseReconciliationFailure: dispatchFailure.managedDatabaseReconciliation },
  });
  assert.equal(databaseOperation.metadata.failureDiagnostic.rootCauseCode, "DG_MANAGED_DATABASE_STALE_METADATA");
  assert.equal(databaseOperation.metadata.failureDiagnostic.failureOwner, "DEPLOYGUARD_PLATFORM");
  assert.equal(databaseOperation.metadata.failureDiagnostic.failureStage, "managed_database_reconciliation");
  assert.equal(databaseOperation.metadata.failureDiagnostic.retryDecision, "NOT_SAFE_YET");
  assert.equal(databaseOperation.metadata.managedDatabaseReconciliationFailure.reconciliationState, ManagedDatabaseReconciliationState.STALE_METADATA);
  assert.doesNotMatch(JSON.stringify(databaseOperation.metadata), /password=|postgresql:\/\/deployguard:/, "only bounded reconciliation facts are persisted");
  console.log("CENTRAL_DIAGNOSTIC_PERSISTENCE_AND_API=PASS");
}

console.log("FAILURE_DIAGNOSTICS_GLOBAL_MATRIX=PASS");
console.log("PNPM_OUTDATED_LOCKFILE_CAUSAL_PRECEDENCE=PASS");
console.log("UNKNOWN_FAILURE_FALLBACK=PASS");
console.log("MULTI_SERVICE_ATTRIBUTION=PASS");
console.log("LIFECYCLE_DIAGNOSTIC_COVERAGE=PASS");
console.log("AI_DIAGNOSTIC_AUTHORITY=PASS");
console.log("DIAGNOSTIC_SECRET_SAFETY=PASS");
console.log("MANAGED_DATABASE_RECONCILIATION_DIAGNOSTICS=PASS STATES=4 ENGINES=3");
verifyCentralPersistenceAndApi().catch((error) => { console.error(error); process.exitCode = 1; });
