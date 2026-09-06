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

console.log("TERMINAL_FAILURE_PATHS_INVENTORIED=5");
console.log("UNROUTED_TERMINAL_FAILURE_PATHS=0");
console.log("GLOBAL_TERMINAL_FAILURE_CAPTURE=PASS");
