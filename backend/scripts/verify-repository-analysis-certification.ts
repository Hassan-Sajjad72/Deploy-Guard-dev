import { strict as assert } from "assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BuildPlan, BUILD_PLAN_DETECTOR_VERSION } from "../src/projects/build-plan";
import { evaluateBuildPlanReadiness } from "../src/projects/build-plan-readiness";
import { canonicalEnvironmentName } from "../src/projects/canonical-environment";
import { partitionSubmittedEnvironmentVariables, provenRepositoryOwnedVariableKeys } from "../src/projects/configuration-ownership";
import { RepoDeployabilityScannerService } from "../src/projects/detection/repo-deployability-scanner.service";
import {
  assertInitialGithubActionsIdentity,
  buildPlanWorkflowInputs,
  decodeEnvironmentReferencesBase64,
  environmentReferencesBase64,
  GITHUB_ACTIONS_INPUT_NAMES,
  GithubActionsRuntimeConfiguration,
} from "../src/projects/github-actions-operation-contract";

const repositoryRoot = join(__dirname, "../..");
const source = (path: string) => readFileSync(join(repositoryRoot, path), "utf8");
const workflow = source(".github/workflows/deployguard-reusable.yml");
const workflowInputBlock = workflow.match(/workflow_call:\s*\n\s*inputs:\s*\n([\s\S]*?)\n\s*permissions:/)?.[1] || "";
const declaredWorkflowInputs = Array.from(workflowInputBlock.matchAll(/^\s{6}([a-z][a-z0-9_]+):/gm), (match) => match[1]).sort();
assert.deepEqual(declaredWorkflowInputs, [...GITHUB_ACTIONS_INPUT_NAMES].sort(), "the inspected reusable workflow and backend operation contract must declare exactly the same inputs");

const githubApp = source("backend/src/projects/github-app.service.ts");
assert.match(githubApp, /deployguard-reusable\.yml@[0-9a-f]{40}/, "caller must pin the exact reusable workflow SHA");
assert.match(githubApp, /GITHUB_ACTIONS_WORKFLOW_INPUTS\.map/, "managed caller must forward the authoritative typed input registry");
const dispatch = source("backend/src/projects/github-actions-deployment.service.ts");
assert.match(dispatch, /\.\.\.buildPlanWorkflowInputs\(plan\)/);
assert.match(dispatch, /generated_dockerfile_base64:/);
assert.match(dispatch, /environment_references_base64:/);

for (const invariant of [
  /base64 --decode > \.deployguard\/build-plan\.json/,
  /\.repositoryFullName == \$repository/,
  /\.branch == \$branch/,
  /\.commitSha == \$commit/,
  /\.components\[\] \| select\(\.role == "frontend"\)/,
  /\.root else \.appRoot end\) == \$appRoot/,
  /\.port else \.port end\) == \$port/,
  /\$componentHealth == null or \$componentHealth == \$health/,
  /\.dockerTemplate else \.dockerTemplate end\) == \$template/,
  /Immutable BuildPlan does not match workflow inputs/,
]) assert.match(workflow, invariant, "workflow must validate the serialized immutable BuildPlan");

const plan: BuildPlan = {
  planVersion: 2, detectorVersion: BUILD_PLAN_DETECTOR_VERSION,
  repositoryFullName: "fixture/app", branch: "main", commitSha: "a".repeat(40), detectorId: "javascript.express",
  language: "javascript", framework: "express", frameworkMode: "express-server", confidence: "0.99", platformBackendMount: "/__deployguard/backend",
  evidence: [{ source: "package.json", description: "express dependency" }], appRoot: ".", repositoryInstallRoot: ".",
  packageManager: "npm", dependencyManifest: "package.json", lockfile: "package-lock.json", runtimeVersion: "22",
  baseImage: "node:22-alpine3.21", runtimeImage: "node:22-alpine3.21", installCommand: "npm ci",
  buildCommand: null, buildCommands: [], releaseCommand: null, releaseCommands: [], runCommand: "node server.js", runtimeFiles: ["."],
  outputDirectory: null, buildSystemDependencies: [], runtimeSystemDependencies: [], port: 3000, portSource: "source",
  healthPath: "/health", bindHost: "0.0.0.0", bindsToPortEnv: true, runtimeType: "server",
  environmentOwnership: [
    { key: "PORT", owner: "platform", required: true, phase: "runtime", secret: false },
    { key: "APP_SECRET", owner: "application", required: true, phase: "runtime", secret: true },
    { key: "PUBLIC_ORIGIN", owner: "repository", required: false, phase: "runtime", secret: false, repositoryValue: "https://repository.example" },
  ],
  requiredInputs: ["APP_SECRET"], requiredUserInputs: [], optionalInputs: [], buildTimeEnvVars: [], runtimeEnvVars: ["APP_SECRET"],
  secretEnvVars: ["APP_SECRET"], dockerStrategy: "generated", dockerTemplate: "express-server", warnings: [], blockers: [], serviceBindings: [],
};

const planInputs = buildPlanWorkflowInputs(plan);
assert.deepEqual(JSON.parse(Buffer.from(planInputs.build_plan_base64, "base64").toString("utf8")), plan);
assert.deepEqual(planInputs, {
  build_plan_base64: planInputs.build_plan_base64, application_root: ".", app_port: "3000", health_check_path: "/health",
  container_profile: "express-server", output_directory: "",
});

const environmentName = canonicalEnvironmentName({ environmentName: "review-42" });
const ignoredPlatformValue = "user-platform-value-must-not-propagate";
const ignoredRepositoryValue = "user-repository-value-must-not-propagate";
const applicationValue = "accepted-application-value";
const ownership = provenRepositoryOwnedVariableKeys([{ key: "PUBLIC_ORIGIN", detectedDefault: "https://repository.example", secret: false }]);
const partition = partitionSubmittedEnvironmentVariables([
  { key: "PORT", value: ignoredPlatformValue },
  { key: "PUBLIC_ORIGIN", value: ignoredRepositoryValue },
  { key: "FEATURE_FLAG", value: applicationValue },
], { repositoryOwnedKeys: ownership });
assert.deepEqual(partition.ignoredVariableNames, ["PORT", "PUBLIC_ORIGIN"]);
assert.deepEqual(partition.accepted, [{ key: "FEATURE_FLAG", value: applicationValue }]);

const missingReadiness = evaluateBuildPlanReadiness(plan, { unresolvedRequiredValues: ["APP_SECRET"] });
assert.equal(missingReadiness.status, "INPUT_REQUIRED");
const configuration: GithubActionsRuntimeConfiguration = {
  schemaVersion: 1,
  configurationSnapshotId: "51515151-5151-4515-8515-515151515151",
  configurationFingerprint: "5".repeat(64),
  projectId: "61616161-6161-4616-8616-616161616161",
  environmentName,
  generationId: "11111111-1111-4111-8111-111111111111",
  generationStateKey: "projects/61616161-6161-4616-8616-616161616161/review-42/11111111-1111-4111-8111-111111111111/terraform.tfstate",
  platformFoundation: {
    vpcId: "vpc-0123456789abcdef0",
    publicSubnetIds: ["subnet-0123456789abcdef0", "subnet-1123456789abcdef0"],
    ecsClusterArn: "arn:aws:ecs:us-east-1:123456789012:cluster/deployguard-shared",
    ecsClusterName: "deployguard-shared",
    albArn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/deployguard-shared/1234567890abcdef",
    albDnsName: "deployguard-shared.us-east-1.elb.amazonaws.com",
    listenerArn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/deployguard-shared/1234567890abcdef/abcdef1234567890",
    albSecurityGroupId: "sg-0123456789abcdef0",
  },
  routing: {
    listenerPriority: 1234,
    verificationPriority: 21234,
    productionHost: "fixture-review-42.example.test",
    candidateHost: "fixture-review-42-candidate.example.test",
  },
  projectPersistence: {
    stateKey: "projects/61616161-6161-4616-8616-616161616161/review-42/project/terraform.tfstate",
    ecrRepositoryName: "deployguard-61616161-6161-4616-8616-616161616161",
    runtimeSecretName: "deployguard/61616161-6161-4616-8616-616161616161/review-42/application/runtime",
    ownershipScope: "project",
  },
  retiredGenerationCleanup: null,
  environment: { FEATURE_FLAG: applicationValue, PORT: "3000", PUBLIC_ORIGIN: "https://repository.example" },
  secretReferences: {},
  deploymentContext: { schemaVersion: 1, deploymentMode: "FRESH", persistentState: "NONE", recoveryState: "NOT_REQUIRED", recoveryRequired: false, recoveryEvidenceAvailable: false, persistentPreviouslyEstablished: false, deploymentAllowed: true, reason: "Fresh fixture." },
  retentionProtectedRelease: { imageDigests: [], taskDefinitionArns: [] },
  promotion: {
    contractVersion: "deployguard.promotion-intent/v1",
    operationId: "71717171-7171-4717-8717-717171717171",
    projectId: "61616161-6161-4616-8616-616161616161",
    environmentName,
    generationId: "11111111-1111-4111-8111-111111111111",
    candidate: null,
    previousLiveGenerationId: null,
    previousTargetGroupArn: null,
    previousListenerRuleArn: null,
    previousProductionUrl: null,
    intentFingerprint: null,
  },
  managedDatabase: null,
};
const encodedConfiguration = environmentReferencesBase64(configuration);
assert.deepEqual(decodeEnvironmentReferencesBase64(encodedConfiguration), configuration);
const serializedBoundary = JSON.stringify({ partition, plan, planInputs, configuration: decodeEnvironmentReferencesBase64(encodedConfiguration) });
assert.doesNotMatch(serializedBoundary, new RegExp(`${ignoredPlatformValue}|${ignoredRepositoryValue}`));
assert.equal(configuration.environmentName, environmentName);
assert.equal(missingReadiness.requiredInputs.includes("APP_SECRET"), true, "readiness and snapshot input set must share required application evidence");

const scanner = new RepoDeployabilityScannerService();
const fixture = mkdtempSync(join(tmpdir(), "deployguard-certification-policy-"));
try {
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ packageManager: "npm@10", scripts: { start: "node server.js" }, dependencies: { express: "^5.0.0" } }));
  writeFileSync(join(fixture, "server.js"), "app.listen(process.env.PORT || 3000, '0.0.0.0')");
  const profile = { ecosystem: "node", framework: "express", packageManager: "npm", buildCommand: null, startCommand: "npm run start", expectedPort: 3000, healthCheckPath: "/health", staticOutput: false, hasDockerfile: false, requiresDatabase: false, requiresPersistentStorage: false };
  const missingLock = scanner.scan(fixture, profile);
  assert.equal(missingLock.installCommand, "npm install");
  assert.match(missingLock.deployabilityWarnings.join(" "), /No JavaScript lockfile/);
  assert.equal(evaluateBuildPlanReadiness({ ...plan, lockfile: null, installCommand: "npm install", warnings: missingLock.deployabilityWarnings }).status, "READY_WITH_WARNINGS");
  writeFileSync(join(fixture, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { express: "^4.0.0" } } } }));
  const staleLock = scanner.scan(fixture, profile);
  assert.match(staleLock.deployabilityBlockers.join(" "), /out of sync/);
  assert.equal(evaluateBuildPlanReadiness({ ...plan, blockers: staleLock.deployabilityBlockers }).status, "BLOCKED");
  writeFileSync(join(fixture, "server.js"), "app.listen(process.env.PORT || 3000, '127.0.0.1')");
  const localhost = scanner.scan(fixture, profile);
  assert.match(localhost.deployabilityBlockers.join(" "), /localhost|0\.0\.0\.0/);
} finally { rmSync(fixture, { recursive: true, force: true }); }

const project = { id: "61616161-6161-4616-8616-616161616161", repositoryFullName: plan.repositoryFullName, targetBranch: plan.branch };
const profileIdentity = { id: "62626262-6262-4626-8626-626262626262", projectId: project.id, repositoryFullName: plan.repositoryFullName, targetBranch: plan.branch, commitSha: plan.commitSha, inputFingerprint: "6".repeat(64) };
const contractIdentity = { projectId: project.id, commitSha: plan.commitSha, detectionSourceCommit: plan.commitSha, contractHash: "7".repeat(64), port: plan.port, healthPath: plan.healthPath, appRoot: plan.appRoot, dockerTemplate: plan.dockerTemplate, dockerStrategy: plan.dockerStrategy, generatedDockerfile: "FROM node:22-alpine3.21", runtimeType: plan.runtimeType, outputDirectory: plan.outputDirectory, ecsPlan: { environmentMappings: [], secretMappings: [] } };
assert.doesNotThrow(() => assertInitialGithubActionsIdentity(project, profileIdentity, contractIdentity, plan.commitSha));
assert.throws(() => assertInitialGithubActionsIdentity(project, profileIdentity, contractIdentity, "b".repeat(40)), (error: any) => error?.code === "stale_commit");

for (const terraformParity of [
  /app_environment_map = merge\(/,
  /PORT = tostring\(var\.app_port\)/,
  /container_port\s+=\s+tonumber\(local\.primary_component\.port\)/,
  /resource "aws_lb_target_group" "app"[\s\S]*?port\s+=\s+tonumber\(local\.primary_component\.port\)/,
  /health_check\s*\{[\s\S]*?path\s+=\s+try\(local\.primary_component\.healthCheckMode, "http"\) == "http" \? local\.primary_component\.healthPath : "\/"/,
  /matcher\s+=\s+try\(local\.primary_component\.healthCheckMode, "http"\) == "http" \? "200-399" : "200-499"/,
  /component\.id == local\.runtime_owner_component\.id \? local\.app_environment : \[for item in local\.app_environment : item if contains\(\["DEPLOYGUARD_OPERATION_ID", "DEPLOYGUARD_PROJECT_ID", "DEPLOYGUARD_ENVIRONMENT"\], item\.name\)\]/,
]) assert.match(workflow, terraformParity, "Terraform/ECS must consume the same workflow runtime values");

console.log("Iteration 4 certification passed: exact workflow inputs, immutable BuildPlan validation, environment value filtering, readiness/snapshot agreement, lock/binding policies, stale-commit rejection, and Terraform/ECS parity.");
