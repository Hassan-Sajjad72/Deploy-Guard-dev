import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractGithubActionsCandidateEvidence,
  isGithubActionsCandidateEvidence,
  promotionIntentFingerprint,
  relationshipVerificationMatchesBuildPlan,
} from "../src/projects/github-actions-promotion-evidence";
import { BuildPlan } from "../src/projects/build-plan";

const root = join(__dirname, "../..");
const workflow = readFileSync(join(root, ".github/workflows/deployguard-reusable.yml"), "utf8");
const backend = readFileSync(join(root, "backend/src/projects/github-actions-deployment.service.ts"), "utf8");

const operationId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const generationId = "33333333-3333-4333-8333-333333333333";
const candidate = {
  contractVersion: "deployguard.candidate-result/v2" as const,
  deploymentOperationId: operationId,
  projectId,
  generationId,
  environmentName: "dev",
  commitSha: "a".repeat(40),
  candidateUrl: "http://candidate.example.test",
  imageUri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/deployguard-app@sha256:${"b".repeat(64)}`,
  imageDigest: `sha256:${"b".repeat(64)}`,
  clusterName: "deployguard-shared",
  serviceName: "dg-candidate",
  ecsServiceArn: "arn:aws:ecs:us-east-1:123456789012:service/deployguard-shared/dg-candidate",
  targetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/dg-candidate/1234567890abcdef",
  candidateListenerRuleArn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener-rule/app/dg-shared/1234567890abcdef/abcdef1234567890",
  taskDefinitionArn: "arn:aws:ecs:us-east-1:123456789012:task-definition/dg-candidate:7",
  appPort: 3000,
  healthCheckPath: "/health",
  configurationFingerprint: "c".repeat(64),
  configurationSnapshotId: "44444444-4444-4444-8444-444444444444",
  databaseBindingId: null,
  secretReferenceNames: [],
  databaseOutputs: null,
  health: {
    ecsStable: true as const,
    expectedTaskDefinitionRunning: true as const,
    expectedImageRunning: true as const,
    relationshipVerificationStatus: "not_required" as const,
    targetHealthVerified: true as const,
    candidateHttpVerified: true as const,
    healthyTargetCount: 1,
    targetStates: ["healthy" as const],
  },
};

assert.equal(isGithubActionsCandidateEvidence(candidate), true, "healthy exact candidate evidence must be accepted");
assert.deepEqual(extractGithubActionsCandidateEvidence(`DEPLOYGUARD_CANDIDATE_RESULT=${JSON.stringify(candidate)}`), candidate);
for (const state of ["initial", "unhealthy", "draining", "unavailable"] as const) {
  assert.equal(isGithubActionsCandidateEvidence({ ...candidate, health: { ...candidate.health, targetStates: [state] } }), false, `${state} target health must fail closed`);
}
assert.equal(isGithubActionsCandidateEvidence({ ...candidate, health: { ...candidate.health, healthyTargetCount: 0, targetStates: [] } }), false);
assert.equal(isGithubActionsCandidateEvidence({ ...candidate, contractVersion: "deployguard.candidate-result/v1" }), false, "legacy candidate evidence must not be treated as the truthful v2 contract");
assert.equal(isGithubActionsCandidateEvidence({ ...candidate, health: { ...candidate.health, relationshipVerificationStatus: undefined } }), false, "relationship evidence must be explicit");
assert.equal(isGithubActionsCandidateEvidence({ ...candidate, health: { ...candidate.health, relationshipVerified: true } }), false, "v2 must reject the obsolete misleading relationship flag");

const fullStackPlan = (verificationPath: string | null): BuildPlan => ({
  components: [{ id: "frontend", role: "frontend" }, { id: "backend", role: "backend" }],
  relationships: [{ from: "frontend", to: "backend", kind: "http", mode: "same-origin", pathPrefix: "/api/v1", stripPathPrefix: false, buildTimeVariable: null, verificationPath }],
} as BuildPlan);
assert.equal(relationshipVerificationMatchesBuildPlan(candidate, fullStackPlan(null)), true, "an API routing prefix without a proven endpoint is not_required, not verified");
assert.equal(relationshipVerificationMatchesBuildPlan({ ...candidate, health: { ...candidate.health, relationshipVerificationStatus: "verified" } }, fullStackPlan(null)), false, "a prefix-only relationship cannot claim a concrete HTTP verification");
assert.equal(relationshipVerificationMatchesBuildPlan({ ...candidate, health: { ...candidate.health, relationshipVerificationStatus: "verified" } }, fullStackPlan("/api/v1/status")), true, "a proven relationship endpoint requires successful verification evidence");
assert.equal(relationshipVerificationMatchesBuildPlan(candidate, fullStackPlan("/api/v1/status")), false, "a proven relationship endpoint cannot be marked not_required");

const intentInput = {
  contractVersion: "deployguard.promotion-intent/v1" as const,
  operationId,
  projectId,
  environmentName: "dev",
  generationId,
  candidate,
  previousLiveGenerationId: null,
  previousTargetGroupArn: null,
  previousListenerRuleArn: null,
  previousProductionUrl: null,
};
assert.match(promotionIntentFingerprint(intentInput), /^[0-9a-f]{64}$/);
assert.notEqual(promotionIntentFingerprint(intentInput), promotionIntentFingerprint({ ...intentInput, generationId: "55555555-5555-4555-8555-555555555555" }));
const shellCanonicalIntent = execFileSync("jq", [
  "-c",
  "--argjson",
  "candidate",
  JSON.stringify(candidate),
  ".promotion | .candidate = $candidate | del(.intentFingerprint)",
], {
  input: JSON.stringify({ promotion: { ...intentInput, candidate: null, intentFingerprint: null } }),
}).toString("utf8").trim();
assert.equal(
  createHash("sha256").update(shellCanonicalIntent).digest("hex"),
  promotionIntentFingerprint(intentInput),
  "the one-run workflow and backend must hash the same immutable promotion intent",
);

for (const invariant of [
  /Verify exact candidate health and write evidence/,
  /describe-target-health --target-group-arn "\$TARGET_GROUP_ARN"/,
  /all\(\.TargetHealthDescriptions\[\]; \.TargetHealth\.State == "healthy"\)/,
  /Candidate target group ownership does not match the immutable generation/,
  /Promote exact verified candidate and write result/,
  /if: inputs\.deployment_action == 'deploy' \|\| inputs\.deployment_action == 'rollback' \|\| inputs\.deployment_action == 'promote'/,
  /CANDIDATE="\$\(jq -c \. \.deployguard\/terraform\/deployguard-result\.json\)"/,
  /INTENT_WITHOUT_FINGERPRINT/,
  /Promotion candidate target group is not owned by the exact immutable generation/,
  /Stable route does not match the authoritative previous route/,
  /Compensate stable route after failed authoritative promotion/,
  /Previous LIVE target is not owned by the authoritative previous generation/,
  /DEPLOYGUARD_COMPENSATION_RESULT=/,
  /ROUTE_VERIFIED=false/,
  /for attempt in \$\(seq 1 30\)/,
  /describe-rules --rule-arns "\$STABLE_RULE_ARN"/,
  /RULE_READY="\$\(printf '%s' "\$STABLE_RULE"/,
  /Production route did not converge after exact candidate cutover/,
  /Candidate route is not owned by the exact immutable generation/,
  /Candidate route remains after successful promotion/,
  /candidateRouteRemoved:true/,
  /COMPONENTS_READY/,
  /RELATIONSHIP_READY/,
  /RELATIONSHIP_VERIFICATION_STATUS="not_required"/,
  /relationshipVerificationStatus:\$relationshipVerificationStatus/,
  /Candidate relationship evidence does not match the immutable BuildPlan/,
  /PLAN_FULL_STACK/,
  /components:\(\.components \/\/ \[\]\)/,
]) assert.match(workflow, invariant);
assert.doesNotMatch(workflow, /curl --fail --silent --show-error --max-time 15 "\$PRODUCTION_URL\$HEALTH_CHECK_PATH" >\/dev\/null \|\|/, "promotion must not fail on one immediate post-cutover HTTP probe");

assert.doesNotMatch(workflow.match(/Verify exact candidate health and write evidence[\s\S]*?Promote exact verified candidate and write result/)?.[0] || "", /modify-rule|create-rule/,
  "candidate verification must not mutate the stable route");
for (const invariant of [
  /promotionState: "route_change_pending"/,
  /promotionState: "route_changed_awaiting_finalization"/,
  /runtimeConfigurationWithPromotionCandidate\(runtime, candidate\)/,
  /candidate\.generationId !== operation\.generationId/,
  /candidate\.deploymentOperationId !== operation\.id/,
  /workflowPhase === "candidate"/,
  /return await this\.beginPromotion\(project, operation, candidate, credential\.token\)/,
  /error instanceof GithubActionsOperationContractError && error\.code === "invalid_contract"/,
  /Promotion rejected the persisted immutable runtime configuration/,
  /const stableRelease = await materializeStableRelease/,
  /await this\.deploymentGenerations\.promoteVerified/,
  /candidateRouteRemoved: evidence\.candidateRouteRemoved/,
  /return stableRelease/,
  /workflowPhase === "promotion" && remote\.conclusion !== "success"/,
  /return this\.beginCompensation/,
  /Authoritative LIVE finalization failed after route cutover/,
  /promotionState: valid \? "compensated" : "compensation_failed"/,
]) assert.match(backend, invariant);

assert.match(backend, /completionEvidence\.includes\("DEPLOYGUARD_RELEASE_RESULT="\)/,
  "a successful current workflow must finalize its inline promotion evidence without another dispatch");

console.log("Two-phase promotion checks passed: exact healthy candidate gating, immutable identity, route isolation, authoritative pending promotion, and deterministic compensation are present.");
