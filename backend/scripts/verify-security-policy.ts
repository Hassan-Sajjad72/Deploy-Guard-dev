import { strict as assert } from "node:assert";
import { ConfigService } from "@nestjs/config";
import { SecurityPolicyDecision } from "../src/projects/project-security-scan.entity";
import { SecurityPolicyService } from "../src/projects/security/security-policy.service";
import { TrivyParserService } from "../src/projects/security/trivy-parser.service";
import { DockerfileSecurityService } from "../src/projects/security/dockerfile-security.service";
import { PipelineWorkerService } from "../src/projects/pipeline/pipeline-worker.service";

function finding(
  type: string,
  target: string,
  severity: string,
  fixedVersion?: string
) {
  const parser = new TrivyParserService();
  return parser.parse(JSON.stringify({
    Results: [{
      Target: target,
      Type: type,
      Vulnerabilities: [{
        VulnerabilityID: `CVE-${type}-${severity}`,
        Severity: severity,
        PkgName: "sample-package",
        InstalledVersion: "1.0.0",
        FixedVersion: fixedVersion,
      }],
    }],
  })).findings[0];
}

const recommended = new SecurityPolicyService(new ConfigService({}));
const appCritical = finding("node-pkg", "app/package-lock.json", "CRITICAL", "1.0.1");
const appNoFix = finding("node-pkg", "app/package-lock.json", "CRITICAL");
const baseCritical = finding("alpine", "node:22-alpine (alpine 3.21)", "CRITICAL", "1.0.1");
const appHigh = finding("python-pkg", "requirements.txt", "HIGH", "2.0.0");

assert.equal(
  recommended.evaluate([]).policyDecision,
  SecurityPolicyDecision.ALLOWED,
  "A clean image must pass"
);

assert.equal(appCritical.origin, "app_dependency");
assert.equal(baseCritical.origin, "base_image");
assert.equal(appNoFix.fixability, "no_fix_available");
assert.equal(
  recommended.evaluate([appCritical]).policyDecision,
  SecurityPolicyDecision.BLOCKED,
  "Fixable Critical application dependencies block by default"
);
assert.equal(
  recommended.evaluate([baseCritical]).policyDecision,
  SecurityPolicyDecision.ALLOWED,
  "Base-image Critical findings must warn by default"
);
assert.equal(
  recommended.evaluate([appNoFix]).policyDecision,
  SecurityPolicyDecision.ALLOWED,
  "No-fix Critical findings must warn by default"
);
assert.equal(
  recommended.evaluate([appHigh]).policyDecision,
  SecurityPolicyDecision.ALLOWED,
  "High findings must warn by default"
);

const strictBase = new SecurityPolicyService(new ConfigService({ SECURITY_BLOCK_BASE_IMAGE_CRITICAL: "true" }));
assert.equal(
  strictBase.evaluate([baseCritical]).policyDecision,
  SecurityPolicyDecision.BLOCKED,
  "Strict policy can block fixable Critical base-image findings"
);

console.log("Security classification and policy verification passed.");

const dockerfiles = new DockerfileSecurityService();
assert.equal(dockerfiles.analyze("FROM node:22-alpine\nUSER node\nCMD [\"node\",\"server.js\"]").passed, true, "A versioned non-root Dockerfile must pass");
assert.equal(dockerfiles.analyze("FROM node:latest\nUSER root").passed, false, "Unsafe base tags and root runtime must block");
assert.equal(dockerfiles.analyze("FROM node:22-alpine\nENV API_SECRET=value\nUSER node").passed, false, "Dockerfile secrets must block");
console.log("Dockerfile deployment-configuration policy verification passed.");

async function verifyBuildAndScannerFailureSemantics() {
  const buildEvents: string[] = [];
  const buildWorker = Object.create(PipelineWorkerService.prototype) as PipelineWorkerService;
  Reflect.set(buildWorker, "dockerBuildService", {
    isDockerAvailable: async () => true,
    buildImage: async () => { throw new Error("controlled build failure"); },
  });
  Reflect.set(buildWorker, "startMetric", async () => undefined);
  Reflect.set(buildWorker, "updateRun", async (_run: unknown, update: { currentStage?: string }) => { if (update.currentStage) buildEvents.push(update.currentStage); });
  Reflect.set(buildWorker, "event", async (_run: unknown, stage: string) => { buildEvents.push(stage); });
  Reflect.set(buildWorker, "audit", async () => undefined);
  Reflect.set(buildWorker, "failMetric", async () => undefined);
  await assert.rejects(
    () => (buildWorker as unknown as { buildDockerImage: (...args: unknown[]) => Promise<void> }).buildDockerImage(
      { id: "run-1", projectId: "project-1" }, null, "/tmp", "image", "tag", { buildTimeEnvVars: [] }
    ),
    /controlled build failure/
  );
  assert(buildEvents.includes("docker_build"), "Build failures must remain in docker_build");
  assert(buildEvents.includes("docker_build_started"));

  const scanEvents: Array<{ stage: string; status: string }> = [];
  const scanWorker = Object.create(PipelineWorkerService.prototype) as PipelineWorkerService;
  Reflect.set(scanWorker, "securityScanService", { scanImage: async () => { throw new Error("controlled Trivy failure"); } });
  Reflect.set(scanWorker, "pipelineMetricsService", { skipStage: async () => undefined });
  Reflect.set(scanWorker, "startMetric", async () => undefined);
  Reflect.set(scanWorker, "updateRun", async () => undefined);
  Reflect.set(scanWorker, "event", async (_run: unknown, stage: string, status: string) => { scanEvents.push({ stage, status }); });
  await (scanWorker as unknown as { runSecurityGate: (...args: unknown[]) => Promise<void> }).runSecurityGate(
    { id: "run-1", projectId: "project-1" }, null, { id: "project-1" }, "image", "tag"
  );
  assert(scanEvents.some((event) => event.stage === "trivy_image_scan_unavailable" && event.status === "warning"));
  assert(scanEvents.some((event) => event.stage === "security_gate_passed_with_scan_warning" && event.status === "warning"));

  let disabledScanCalls = 0;
  const bypassEvents: Array<{ stage: string; status: string }> = [];
  const bypassWorker = Object.create(PipelineWorkerService.prototype) as PipelineWorkerService;
  Reflect.set(bypassWorker, "config", new ConfigService({
    TRIVY_SCAN_ENABLED: "false",
    SECURITY_GATE_MODE: "enforce",
  }));
  Reflect.set(bypassWorker, "securityScanService", {
    scanImage: async () => { disabledScanCalls += 1; throw new Error("Disabled scanner must not run"); },
  });
  Reflect.set(bypassWorker, "pipelineMetricsService", { skipStage: async () => undefined });
  Reflect.set(bypassWorker, "startMetric", async () => undefined);
  Reflect.set(bypassWorker, "updateRun", async () => undefined);
  Reflect.set(bypassWorker, "audit", async () => undefined);
  Reflect.set(bypassWorker, "event", async (_run: unknown, stage: string, status: string) => {
    bypassEvents.push({ stage, status });
  });
  await (bypassWorker as unknown as { runSecurityGate: (...args: unknown[]) => Promise<void> }).runSecurityGate(
    { id: "run-demo", projectId: "project-demo" }, null, { id: "project-demo" }, "image", "tag"
  );
  assert.equal(disabledScanCalls, 0);
  assert(bypassEvents.some((event) => event.stage === "security_gate_bypassed" && event.status === "skipped"));

  const explicitBypass = new SecurityPolicyService(new ConfigService({
    SECURITY_BYPASS_ENABLED: "true",
    SECURITY_BLOCK_CRITICAL: "true",
    SECURITY_BLOCK_HIGH: "true",
  }));
  assert.equal(explicitBypass.evaluate([appCritical, appHigh]).policyDecision, SecurityPolicyDecision.ALLOWED);
}

verifyBuildAndScannerFailureSemantics()
  .then(() => console.log("Docker build failure, advisory scan, and demo bypass semantics passed."))
  .catch((error) => { console.error(error); process.exitCode = 1; });
