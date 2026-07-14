import { strict as assert } from "node:assert";
import { ConfigService } from "@nestjs/config";
import { SecurityPolicyDecision } from "../src/projects/project-security-scan.entity";
import { SecurityPolicyService } from "../src/projects/security/security-policy.service";
import { TrivyParserService } from "../src/projects/security/trivy-parser.service";
import { DockerfileSecurityService } from "../src/projects/security/dockerfile-security.service";

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

assert.equal(appCritical.origin, "app_dependency");
assert.equal(baseCritical.origin, "base_image");
assert.equal(appNoFix.fixability, "no_fix_available");
assert.equal(
  recommended.evaluate([appCritical]).policyDecision,
  SecurityPolicyDecision.ALLOWED,
  "Application dependency vulnerabilities are advisory"
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
  SecurityPolicyDecision.ALLOWED,
  "Image vulnerability configuration cannot turn CVEs into a release gate"
);

console.log("Security classification and policy verification passed.");

const dockerfiles = new DockerfileSecurityService();
assert.equal(dockerfiles.analyze("FROM node:22-alpine\nUSER node\nCMD [\"node\",\"server.js\"]").passed, true, "A versioned non-root Dockerfile must pass");
assert.equal(dockerfiles.analyze("FROM node:latest\nUSER root").passed, false, "Unsafe base tags and root runtime must block");
assert.equal(dockerfiles.analyze("FROM node:22-alpine\nENV API_SECRET=value\nUSER node").passed, false, "Dockerfile secrets must block");
console.log("Dockerfile deployment-configuration policy verification passed.");
