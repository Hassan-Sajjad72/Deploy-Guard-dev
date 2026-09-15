import { strict as assert } from "node:assert";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ConfigService } from "@nestjs/config";
import { getTrivyConfig } from "../src/projects/trivy.config";
import { RAILPACK_WORKFLOW_INPUTS } from "../src/projects/railpack-workflow-contract";

assert.deepEqual(getTrivyConfig(new ConfigService({})), { enabled: false, enforce: false });
assert.deepEqual(getTrivyConfig(new ConfigService({ TRIVY_ENABLED: "true", TRIVY_ENFORCE: "false" })), { enabled: true, enforce: false });
assert.deepEqual(getTrivyConfig(new ConfigService({ TRIVY_ENABLED: "true", TRIVY_ENFORCE: "true" })), { enabled: true, enforce: true });
assert.deepEqual(getTrivyConfig(new ConfigService({ TRIVY_ENABLED: "false", TRIVY_ENFORCE: "true" })), { enabled: false, enforce: false });
assert.throws(() => getTrivyConfig(new ConfigService({ TRIVY_ENABLED: "sometimes" })), /true or false/);
assert.ok(RAILPACK_WORKFLOW_INPUTS.some(({ name }) => name === "trivy_enabled"));
assert.ok(RAILPACK_WORKFLOW_INPUTS.some(({ name }) => name === "trivy_enforce"));
const workflow = readFileSync(join(__dirname, "../../.github/workflows/deployguard-reusable.yml"), "utf8");
assert.match(workflow, /inputs\.trivy_enabled == 'true'/);
assert.match(workflow, /status:\"advisory\"|echo advisory/);
assert.match(workflow, /DG_TRIVY_POLICY_BLOCKED/);
assert.match(workflow, /DG_TRIVY_SCAN_FAILED/);
assert.match(workflow, /Deployment blocked by Trivy security policy\./);
assert.match(workflow, /deployguard\.security-result\/v1/);
assert.match(workflow, /securityScan:\$security\[0\]/);
assert.match(workflow, /failureEvent:\{contractVersion:"deployguard\.failure-event\/v1"/);
console.log("Trivy control certification passed: disabled, advisory, enforced, immutable evidence, and workflow forwarding paths are present.");

// Execute the workflow's result assembly with evidence exceeding Linux's per-argument limit.
const directory = mkdtempSync(join(tmpdir(), "deployguard-trivy-payload-"));
try {
  mkdirSync(join(directory, ".deployguard/security"), { recursive: true });
  const findings = Array.from({ length: 600 }, (_, index) => ({
    serviceId: "service-a", image: "registry/image@sha256:" + "a".repeat(64),
    vulnerabilityId: `CVE-${String(index).padStart(5, "0")}`, severity: "CRITICAL",
    packageName: "dependency-" + "x".repeat(400), installedVersion: "1.0.0",
    fixedVersion: "1.0.1", target: "package-lock.json", type: "node-pkg", origin: "app_dependency",
  }));
  writeFileSync(join(directory, "findings.json"), JSON.stringify(findings));
  const assembly = workflow.slice(workflow.indexOf('            counts="$(jq'), workflow.indexOf('          if [ "$TRIVY_ENFORCE" = true ]'));
  assert.ok(assembly.includes("--slurpfile evidence"));
  const body = assembly.slice(0, assembly.lastIndexOf("          fi"));
  for (const enforced of ["false", "true"]) {
    const execution = spawnSync("bash", ["-euo", "pipefail", "-c", body], {
      cwd: directory, encoding: "utf8", env: { ...process.env, findings: "findings.json", result: "result.json", OPERATION_ID: "operation", PROJECT_ID: "project", SOURCE_SHA: "a".repeat(40), TRIVY_ENFORCE: enforced },
    });
    assert.equal(execution.status, 0, execution.stderr);
    const result = JSON.parse(readFileSync(join(directory, "result.json"), "utf8"));
    assert.equal(result.status, enforced === "true" ? "blocked" : "advisory");
    assert.equal(result.counts.total, 600);
    assert.equal(result.blockingFindingCount, 600);
    assert.deepEqual(result.evidence, findings.slice(0, 500));
    const canonical = JSON.stringify(result.evidence);
    assert.ok(Buffer.byteLength(canonical) > 131072);
    assert.equal(result.evidenceHash, createHash("sha256").update(canonical).digest("hex"));
  }
  console.log("Trivy large-payload workflow execution passed: advisory/enforced, full counts, 500 findings, unchanged hash.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
