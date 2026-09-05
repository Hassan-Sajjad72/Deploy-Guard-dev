import { strict as assert } from "node:assert";
import { LogSanitizerService } from "../src/observability/log-sanitizer.service";
import { AiEvidencePreprocessorService } from "../src/ai-troubleshooting/ai-evidence-preprocessor.service";
import { FailureDiagnosticService } from "../src/projects/failure-diagnostics/failure-diagnostic.service";
import { DeploymentFailureDiagnosticInput } from "../src/projects/failure-diagnostics/failure-diagnostic.types";
import { classifyStructuredFailure } from "../src/projects/failure-ownership";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";

const sanitizer = new LogSanitizerService();
const service = new FailureDiagnosticService(sanitizer);
const now = new Date("2026-01-02T03:04:05.000Z");
const serviceId = "11111111-1111-4111-8111-111111111111";

function diagnose(evidence: string, overrides: Partial<DeploymentFailureDiagnosticInput> = {}) {
  const stage = overrides.failureStage || "railpack_build";
  const terminalFailureCode = overrides.terminalFailureCode || "DG_RAILPACK_BUILD_FAILED";
  const authority = classifyStructuredFailure(stage, `DG_FAILURE code=${terminalFailureCode} stage=${stage}${overrides.serviceId ? ` serviceId=${overrides.serviceId}` : ""}`);
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

const structuredCases: Array<[string, string, DeploymentFailureDiagnosticInput["failureOwner"], DeploymentFailureDiagnosticInput["externalProvider"], string]> = [
  ["DG_DEPLOYMENT_INPUT_REQUIRED", "deployment_requirement_admission", "DEPLOYGUARD_PLATFORM", null, "DG_CONFIGURATION_INPUT_REQUIRED"],
  ["DG_DEPLOYMENT_REQUIREMENTS_BLOCKED", "deployment_requirement_admission", "DEPLOYGUARD_PLATFORM", null, "DG_CONFIGURATION_ADMISSION_BLOCKED"],
  ["DG_SERVICE_PORT_CONFLICT", "service_port_resolution", "REPOSITORY_APPLICATION", null, "DG_APPLICATION_PORT_CONFLICT"],
  ["DG_MANAGED_DATABASE_READINESS_FAILED", "database_readiness", "DEPLOYGUARD_PLATFORM", null, "DG_MANAGED_DATABASE_PLATFORM_READINESS_FAILED"],
  ["DG_MANAGED_MYSQL_GRANT_RECONCILIATION_FAILED", "database_grants", "DEPLOYGUARD_PLATFORM", null, "DG_MANAGED_MYSQL_GRANT_RECONCILIATION_FAILED"],
  ["DG_RAILPACK_PREREQUISITE_FAILED", "railpack_setup", "EXTERNAL_PROVIDER", "railpack", "DG_RAILPACK_PROVIDER_PREREQUISITE_FAILED"],
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
}

for (const action of ["deploy", "rollback", "destroy"] as const) {
  const result = diagnose("ambiguous terminal failure", { deploymentAction: action });
  assert.equal(result.deploymentAction, action);
  assert.equal(result.rootCauseCode, "DG_FAILURE_CAUSE_UNVERIFIED");
}
const redeploy = diagnose("ambiguous redeploy terminal failure", { deploymentAction: "deploy" });
assert.equal(redeploy.deploymentAction, "deploy", "redeploy uses the frozen deploy action contract");

const unknown = diagnose("command returned a non-zero result with no specific causal evidence");
assert.equal(unknown.rootCauseCode, "DG_FAILURE_CAUSE_UNVERIFIED");
assert.equal(unknown.failureOwner, "UNVERIFIED");
assert.equal(unknown.retryDecision, "INSUFFICIENT_EVIDENCE");
assert.equal(unknown.confidence, "UNVERIFIED");
assert.ok(unknown.evidenceReferences[0].excerpt.length > 0);
const unknownRuntime = diagnose("container stopped for an unknown reason", { failureStage: "application_runtime", terminalFailureCode: "DG_FAILURE_UNVERIFIED" });
assert.equal(unknownRuntime.rootCauseCode, "DG_FAILURE_CAUSE_UNVERIFIED");

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
  console.log("CENTRAL_DIAGNOSTIC_PERSISTENCE_AND_API=PASS");
}

console.log("FAILURE_DIAGNOSTICS_GLOBAL_MATRIX=PASS");
console.log("PNPM_OUTDATED_LOCKFILE_CAUSAL_PRECEDENCE=PASS");
console.log("UNKNOWN_FAILURE_FALLBACK=PASS");
console.log("MULTI_SERVICE_ATTRIBUTION=PASS");
console.log("LIFECYCLE_DIAGNOSTIC_COVERAGE=PASS");
console.log("AI_DIAGNOSTIC_AUTHORITY=PASS");
console.log("DIAGNOSTIC_SECRET_SAFETY=PASS");
verifyCentralPersistenceAndApi().catch((error) => { console.error(error); process.exitCode = 1; });
