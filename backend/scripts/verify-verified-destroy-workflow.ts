import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractGithubActionsDestroyEvidence } from "../src/projects/github-actions-destroy-evidence";

const root = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const operationId = "9ffe6827-f55a-4469-ac80-64530f8cea2e";
const projectId = "b713ea5b-589b-4ab4-8175-6af7dc2ed402";
const generations = [
  "404cd3c1-a7dd-4b26-85e9-f531b3cb7ef1",
  "11111111-2222-4333-8444-555555555555",
];
const evidence = {
  contractVersion: "deployguard.destroy-result/v2" as const,
  deploymentOperationId: operationId,
  projectId,
  environmentName: "dev",
  generationIds: generations,
  status: "project_delete_ready" as const,
  generationResourcesRemoved: true as const,
  projectResourcesRemoved: true as const,
  terraformStateArtifactsRemoved: true as const,
  sharedPlatformUntouched: true as const,
  verifiedAt: "2026-08-12T12:00:00.000Z",
};

assert.deepEqual(
  extractGithubActionsDestroyEvidence(`DEPLOYGUARD_DESTROY_RESULT=${JSON.stringify(evidence)}`),
  { ...evidence, generationIds: [...generations].sort() },
);
for (const field of [
  "generationResourcesRemoved",
  "projectResourcesRemoved",
  "terraformStateArtifactsRemoved",
  "sharedPlatformUntouched",
] as const) {
  assert.equal(
    extractGithubActionsDestroyEvidence(`DEPLOYGUARD_DESTROY_RESULT=${JSON.stringify({ ...evidence, [field]: false })}`),
    null,
    `${field} is mandatory`,
  );
}
assert.equal(
  extractGithubActionsDestroyEvidence(`DEPLOYGUARD_DESTROY_RESULT=${JSON.stringify({ ...evidence, generationIds: [generations[0], generations[0]] })}`),
  null,
  "generation identities must be unique",
);

const workflow = read(".github/workflows/deployguard-reusable.yml");
const deployment = read("backend/src/projects/github-actions-deployment.service.ts");
const currentState = read("backend/src/projects/current-state/project-current-state.service.ts");
const policy = read("backend/src/projects/github-actions-aws-capability-contract.ts");

assert.match(workflow, /contractVersion:"deployguard\.destroy-result\/v2"/);
assert.match(workflow, /Destroy other recorded generations exactly/);
assert.match(workflow, /projects\/\$PROJECT_ID\/\$ENVIRONMENT_NAME\/\$RECORDED_ID\/terraform\.tfstate/);
assert.match(workflow, /Destroy project-scoped persistence/);
assert.match(workflow, /Delete exact project-owned runtime artifacts/);
assert.match(workflow, /Destroy consumes only the validated project-deletion context/);
assert.match(workflow, /if \[ "\$DEPLOYMENT_ACTION" = "destroy" \]; then[\s\S]*?variable "aws_region"[\s\S]*?JSON\.stringify\(\{ aws_region: process\.env\.AWS_REGION \}\)[\s\S]*?exit 0/);
assert.match(workflow, /projectDeletion\.projectResources\.stableListenerRuleArn/);
assert.match(workflow, /Stable route ownership mismatch[\s\S]*?aws elbv2 delete-rule/, "Destroy removes only the exact persisted project route before Terraform destroys its target group");
assert.match(workflow, /ListenerRuleNotFound\|RuleNotFound/, "an exact stable rule that was already removed is an idempotent Destroy success");
assert.match(workflow, /Destroy other recorded generations exactly[\s\S]{0,2500}jq -n --arg aws_region "\$AWS_REGION" '\{aws_region:\$aws_region\}'/, "recorded generations receive only the Destroy-specific provider configuration");
assert.match(workflow, /for status in ACTIVE INACTIVE/, "project deletion handles every exact-tagged task-definition revision");
assert.match(workflow, /Delete exact project-owned runtime artifacts[\s\S]{0,700}PROJECT_PREFIX="\$\(printf '%s' "\$PROJECT_ID"/, "runtime-artifact cleanup defines its own project prefix instead of relying on shell-local state from an earlier step");
assert.match(workflow, /DeployGuardGenerationId == \$generation[\s\S]*continue[\s\S]*delete-task-definitions/, "task definitions outside the exact generation ownership boundary are skipped");
assert.match(workflow, /Verify exact project deletion and write result/);
assert.match(workflow, /sharedPlatformUntouched:true/);
assert.match(workflow, /\.projectDeletion\.generations\[\]\.terraformStateKey/);
assert.match(workflow, /\.projectDeletion\.projectResources\.terraformStateKey/);
assert.doesNotMatch(workflow, /terraform import|terraform state (?:rm|mv)/);
assert.doesNotMatch(workflow, /resourcegroupstaggingapi|get-resources/);
assert.doesNotMatch(workflow, /DEPLOYGUARD_DESTROY_PROGRESS|DESTROY_INCOMPLETE/);
assert.doesNotMatch(workflow, /resource "aws_ecs_cluster"/);
assert.doesNotMatch(workflow, /resource "aws_lb" "app"/);
assert.doesNotMatch(workflow, /project-extinction|extinction\./i);
assert.match(deployment, /projectDeletion\.finalize\(project, saved\)/);
assert.match(deployment, /stableListenerRuleArn: stableListenerRuleArn \|\| null/);
assert.doesNotMatch(deployment, /assertNoDestroyLifecycle|resumeDestroyLifecycle|destroyLifecycles|legacyDestroy/);
assert.match(currentState, /deployguard\.destroy-result\/v2/);
assert.doesNotMatch(currentState, /LegacyDestroy|legacyDestroy/);
assert.doesNotMatch(policy, /DeleteVpc|DeleteSubnet|DeleteLoadBalancer|DeleteListener|DeleteCluster/);

console.log("Exact-scope project deletion checks passed: all recorded generations and project resources are deleted without shared-platform discovery or a competing Destroy lifecycle.");
