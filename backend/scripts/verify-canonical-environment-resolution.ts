import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalEnvironmentName } from "../src/projects/canonical-environment";
import {
  ignoredSubmittedVariableNames,
  partitionSubmittedEnvironmentVariables,
  provenRepositoryOwnedVariableKeys,
} from "../src/projects/configuration-ownership";
import { extractGithubActionsReleaseEvidence } from "../src/projects/github-actions-release-evidence";

const ignoredSecret = "ignored-platform-value-must-never-cross-boundary";
const repositorySecret = "ignored-repository-value-must-never-cross-boundary";
const repositoryOwnedKeys = provenRepositoryOwnedVariableKeys([
  { key: "PUBLIC_ORIGIN", detectedDefault: "https://repository.example", secret: false },
  { key: "APP_SECRET", secret: true },
]);

assert.equal(canonicalEnvironmentName({ environmentName: "review-17" }), "review-17");
assert.equal(canonicalEnvironmentName({}), "dev");
assert.throws(() => canonicalEnvironmentName({ environmentName: "Production" }), /invalid immutable/);

const submitted = [
  { key: "PORT", value: ignoredSecret },
  { key: "AWS_ACCESS_KEY_ID", value: ignoredSecret },
  { key: "GITHUB_TOKEN", value: ignoredSecret },
  { key: "ACTIONS_RUNTIME_TOKEN", value: ignoredSecret },
  { key: "TF_VAR_region", value: ignoredSecret },
  { key: "DEPLOYGUARD_PROJECT_ID", value: ignoredSecret },
  { key: "PUBLIC_ORIGIN", value: repositorySecret },
  { key: "FEATURE_FLAG", value: "enabled" },
  { key: "UNKNOWN_VALID_APP_VARIABLE", value: "optional" },
];
const partition = partitionSubmittedEnvironmentVariables(submitted, { repositoryOwnedKeys });
assert.deepEqual(partition.ignoredVariableNames, ["ACTIONS_RUNTIME_TOKEN", "AWS_ACCESS_KEY_ID", "DEPLOYGUARD_PROJECT_ID", "GITHUB_TOKEN", "PORT", "PUBLIC_ORIGIN", "TF_VAR_REGION"]);
assert.deepEqual(partition.accepted.map((item) => item.key), ["FEATURE_FLAG", "UNKNOWN_VALID_APP_VARIABLE"]);
assert.doesNotMatch(JSON.stringify(partition), new RegExp(`${ignoredSecret}|${repositorySecret}`));
assert.deepEqual(ignoredSubmittedVariableNames(["DB_HOST", "FEATURE_FLAG"], { service: "postgres", managedService: true }), ["DB_HOST"]);

const root = join(__dirname, "../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const resolver = read("backend/src/infrastructure/database-service-binding.service.ts");
assert.match(resolver, /variable\.environment = :environment/);
assert.match(resolver, /repositoryOwnedKeys\.has\(key\)/);
assert.match(resolver, /blockers\.push\(\.\.\.duplicateOwnershipConflicts\)/);
assert.doesNotMatch(resolver, /blockers\.push\(\.\.\.prohibitedOverrides/);
for (const path of [
  "backend/src/projects/projects.service.ts",
  "backend/src/projects/deployment-contract.service.ts",
  "backend/src/projects/templates/preflight.service.ts",
  "backend/src/projects/github-actions-deployment.service.ts",
]) assert.match(read(path), /canonicalEnvironmentName/);

const workflow = read(".github/workflows/deployguard-reusable.yml");
assert.match(workflow, /--arg environmentName "\$ENVIRONMENT_NAME"/);
assert.match(workflow, /environmentName:\$environmentName/);
assert.match(workflow, /Environment\s+=\s+var\.environment_name/);
assert.match(workflow, /environment\s+=\s+local\.app_environment/);

const fingerprint = "1".repeat(64);
const snapshotId = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const evidence = extractGithubActionsReleaseEvidence(`DEPLOYGUARD_RELEASE_RESULT=${JSON.stringify({
  deploymentOperationId: "01234567-89ab-4cde-8fab-0123456789ab",
  environmentName: "review-17",
  commitSha: "a".repeat(40),
  imageUri: `563149050793.dkr.ecr.us-east-1.amazonaws.com/deployguard-app@sha256:${"a".repeat(64)}`,
  imageDigest: `sha256:${"a".repeat(64)}`,
  taskDefinitionArn: "arn:aws:ecs:us-east-1:563149050793:task-definition/dg-app:3",
  clusterName: "dg-app", serviceName: "dg-app", appPort: 3000, healthCheckPath: "/health",
  configurationFingerprint: fingerprint, configurationSnapshotId: snapshotId,
  databaseBindingId: null, secretReferenceNames: [], databaseOutputs: null,
})}`);
assert.equal(evidence?.environmentName, "review-17");
assert.doesNotMatch(JSON.stringify(evidence), new RegExp(`${ignoredSecret}|${repositorySecret}`));

console.log("Canonical environment resolution passed: immutable identity, ignored-name-only filtering, optional application inputs, snapshot scope, workflow/Terraform/ECS handoff, and release evidence parity.");
