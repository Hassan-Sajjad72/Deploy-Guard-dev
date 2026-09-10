import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(__dirname, "../src/projects/railpack-deployment.service.ts"), "utf8");
const failedAssignments = [...source.matchAll(/operation\.status\s*=\s*PipelineRunStatus\.FAILED/g)];
assert.equal(failedAssignments.length, 1, "ProjectPipelineRun terminal failure state must be written only by the central intake");

const central = source.match(/private async captureTerminalFailure[\s\S]*?\n  private failureServiceName/)?.[0] || "";
assert.match(central, /operation\.status\s*=\s*PipelineRunStatus\.FAILED/);
assert.match(central, /diagnostics\.diagnose\(/);
assert.match(central, /metadata\.failureDiagnostic/);
assert.match(central, /await this\.runs\.save\(operation\)/);

const routes = [
  ["pre-dispatch admission/dispatch", /catch \(error\)[\s\S]{0,1200}captureTerminalFailure\(operation/],
  ["GitHub Actions terminal conclusion", /GitHub Actions concluded:[\s\S]{0,1000}captureTerminalFailure\(operation/],
  ["verified release finalization", /persistFinalizationFailure[\s\S]{0,700}captureTerminalFailure\(operation/],
  ["terminal result evidence validation", /persistTerminalEvidenceFailure[\s\S]{0,700}captureTerminalFailure\(operation/],
  ["verified destroy local cleanup", /persistDestroyCleanupFailure[\s\S]{0,700}captureTerminalFailure\(operation/],
] as const;
for (const [name, pattern] of routes) assert.match(source, pattern, `${name} must route through central diagnostic intake`);

const appModule = readFileSync(resolve(__dirname, "../src/app.module.ts"), "utf8");
assert.doesNotMatch(appModule, /InfrastructureLifecycleModule/, "retired infrastructure mutation providers must remain outside the supported product graph");
const githubActions = readFileSync(resolve(__dirname, "../src/projects/pipeline/github-actions.service.ts"), "utf8");
const currentState = readFileSync(resolve(__dirname, "../src/projects/current-state/project-current-state.service.ts"), "utf8");
const aiEvidence = readFileSync(resolve(__dirname, "../src/ai-troubleshooting/ai-evidence.service.ts"), "utf8");
const catalog = readFileSync(resolve(__dirname, "../src/projects/failure-diagnostics/failure-contract.catalog.ts"), "utf8");
assert.match(githubActions, /deployguard\.failure-event\/v1[\s\S]*persistedMarkers/, "structured workflow failure artifacts feed the central terminal intake");
assert.match(githubActions, /structuredFailure\.sourceSha === artifact\.sourceSha/, "structured workflow failures remain bound to the immutable source identity");
assert.match(githubActions, /structuredFailure\.projectId === security\.projectId/, "Trivy failures remain bound to the security artifact project identity");
assert.match(currentState, /diagnosis:\s*currentDiagnosis/, "monitoring/current-state projection consumes the central persisted diagnosis");
assert.match(aiEvidence, /deployguard_build_identity[\s\S]*buildIdentity[\s\S]*builderFailure/, "AI evidence receives bounded service build identity and builder metadata");
assert.match(catalog, /DG_TRIVY_POLICY_BLOCKED[\s\S]*Deployment blocked by Trivy security policy\./, "Trivy policy block has one canonical user-facing diagnosis");

console.log("TERMINAL_FAILURE_PATHS_INVENTORIED=5");
console.log("UNROUTED_TERMINAL_FAILURE_PATHS=0");
console.log("GLOBAL_TERMINAL_FAILURE_CAPTURE=PASS");
