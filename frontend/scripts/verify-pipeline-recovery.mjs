import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { confidenceLabel, failureOwnerLabel, failureOwnerShort, retryGuidance } from "../src/utils/failurePresentation.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const pipeline = read("../src/pages/ProjectPipeline.jsx");
const execution = read("../src/components/projects/PipelineExecution.jsx");
const troubleshooting = read("../src/pages/ProjectTroubleshooting.jsx");

// One owner for failure explanation: Troubleshoot. Deployments records attempts and links to it.
assert.match(pipeline, /getGithubActionsDeploymentHistory/);
assert.doesNotMatch(pipeline, /PipelineRecoveryPanel|recoveryRefreshVersion|troubleshooting|platformApi/, "Deployments owns no diagnosis or AI state");
assert.doesNotMatch(execution, /remediationSteps|startTroubleshooting|getTroubleshootingSession/, "the diagnosis is not repeated on Deployments");
assert.match(execution, /troubleshooting\?operation=\$\{latest\.id\}/, "the latest failure links to its diagnosis");
assert.match(execution, /details\.safeLog \? <Disclosure summary="Failure log \(sanitized\)">/, "sanitized failure evidence stays reachable from each attempt");

// The deterministic diagnosis comes first and stays authoritative over AI.
assert.ok(troubleshooting.indexOf('id="ts-what"') < troubleshooting.indexOf('id="ts-fix"'), "what happened precedes how to fix it");
assert.ok(troubleshooting.indexOf('id="ts-fix"') < troubleshooting.indexOf('id="ts-ai"'), "the deterministic fix precedes AI analysis");
assert.match(troubleshooting, /diagnosis\.remediationSteps/);
assert.match(troubleshooting, /operation\.diagnosis\.recommendedAction/);
assert.match(troubleshooting, /diagnosis\?\.rootCauseCode/);
assert.match(troubleshooting, /retryGuidance\(diagnosis\?\.retryDecision\)/);
assert.match(troubleshooting, /confidenceLabel\(diagnosis\?\.confidence\)/);
assert.match(troubleshooting, /operation\.diagnosis\?\.failureOwner \|\| operation\.failureOwner/, "canonical diagnosis ownership supersedes legacy operation ownership");
assert.match(troubleshooting, /operation\.diagnosis\?\.terminalFailureCode \|\| operation\.failureCode/, "terminal code retains historical fallback");
assert.match(troubleshooting, /AI explanation only\. DeployGuard's persisted deterministic diagnosis above remains authoritative\./);
assert.doesNotMatch(troubleshooting, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN/);

// Plain-language vocabulary, one name per concept.
assert.match(failureOwnerLabel("REPOSITORY_APPLICATION"), /your repository/);
assert.match(failureOwnerLabel("DEPLOYGUARD_PLATFORM"), /DeployGuard's side, not in your code/);
assert.match(failureOwnerLabel("EXTERNAL_PROVIDER", "aws"), /\(AWS\)/);
assert.equal(failureOwnerShort("UNVERIFIED"), "Not verified", "unknown ownership is never guessed");
assert.match(retryGuidance("SAFE_AFTER_FIX").text, /Retrying the same commit will fail the same way/, "an immutable commit that failed for a repository reason is not retried as-is");
assert.equal(retryGuidance("SAFE_NOW").short, "Safe to retry");
assert.equal(retryGuidance("INSUFFICIENT_EVIDENCE").short, "Not enough evidence");
assert.equal(confidenceLabel("DETERMINISTIC"), "Confirmed by recorded evidence");
assert.equal(confidenceLabel("UNVERIFIED"), "Not verified");
console.log("PIPELINE_RECOVERY=PASS DETERMINISTIC_DIAGNOSIS_FIRST=1 SANITIZED_EVIDENCE=1 SINGLE_DIAGNOSIS_OWNER=1");
