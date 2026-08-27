import "reflect-metadata";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DetectionStatus } from "../src/projects/project-detection-profile.entity";
import { refreshDeploymentAnalysisIfStale } from "../src/projects/deployment-analysis-refresh";
import { evaluateBuildPlanReadiness } from "../src/projects/build-plan-readiness";
import { buildPlanWorkflowInputs, GITHUB_ACTIONS_WORKFLOW_INPUTS } from "../src/projects/github-actions-operation-contract";
import { renderDeployguardCallerWorkflow } from "../src/projects/github-app.service";
import { githubWorkflowDispatchInputs } from "../src/projects/pipeline/github-actions.service";
import {
  assertReusableWorkflowCompatibility,
  generatedCallerWithKeys,
  GithubActionsWorkflowContractError,
  parsePinnedReusableWorkflow,
  reusableWorkflowInputDeclarations,
} from "../src/projects/github-actions-workflow-contract";
import { BUILD_PLAN_DETECTOR_VERSION } from "../src/projects/build-plan";

const root = join(__dirname, "../..");
const reusable = readFileSync(join(root, ".github/workflows/deployguard-reusable.yml"), "utf8");
const sha = "b".repeat(40);
const reference = `Hassan-Sajjad72/Deploy-Guard-dev/.github/workflows/deployguard-reusable.yml@${sha}`;
const pinned = parsePinnedReusableWorkflow(reference);
const caller = renderDeployguardCallerWorkflow(reference);

async function run() {
assert.equal(pinned.sha, sha, "the exact immutable SHA is parsed");
assert.throws(() => parsePinnedReusableWorkflow(reference.replace(sha, "main")), GithubActionsWorkflowContractError, "moving refs are rejected");
const declarations = reusableWorkflowInputDeclarations(reusable);
assert.match(reusable, /Validated against deployguard\.workflow-call\/v2/);
assert.deepEqual(declarations.map((input) => input.name), GITHUB_ACTIONS_WORKFLOW_INPUTS.map((input) => input.name));
assert.deepEqual(generatedCallerWithKeys(caller), GITHUB_ACTIONS_WORKFLOW_INPUTS.map((input) => input.name), "caller with keys exactly match reusable keys");
assert.doesNotThrow(() => assertReusableWorkflowCompatibility(reusable, pinned, generatedCallerWithKeys(caller)));
const incompatiblePinnedCaller = renderDeployguardCallerWorkflow(reference.replace(sha, "a".repeat(40)));
assert.notEqual(caller, incompatiblePinnedCaller, "an existing caller pinned to an incompatible revision is stale and will be regenerated");
assert.match(caller, new RegExp(`uses: .*@${sha}`), "regenerated caller uses the configured compatible immutable revision");

const withoutBuildPlan = reusable.replace(/^      build_plan_base64:.*\n/m, "");
assert.throws(
  () => assertReusableWorkflowCompatibility(withoutBuildPlan, pinned, generatedCallerWithKeys(caller)),
  (error: unknown) => error instanceof GithubActionsWorkflowContractError && error.message.includes(`build_plan_base64`) && error.message.includes(sha),
  "the exact production startup failure is caught locally",
);
const missingRequiredCaller = generatedCallerWithKeys(caller).filter((name) => name !== "commit_sha");
assert.throws(() => assertReusableWorkflowCompatibility(reusable, pinned, missingRequiredCaller), /missing required pinned-workflow input `commit_sha`/);
assert.throws(() => assertReusableWorkflowCompatibility(reusable, pinned, [...generatedCallerWithKeys(caller), "unknown_input"]), /caller input `unknown_input`/);

const plan: any = {
  planVersion: 2, detectorVersion: BUILD_PLAN_DETECTOR_VERSION, platformBackendMount: "/__deployguard/backend", serviceBindings: [], repositoryFullName: "owner/repo", branch: "main", commitSha: "c".repeat(40),
  appRoot: ".", repositoryInstallRoot: ".", port: 8080, healthPath: "/", dockerTemplate: "react-webpack-static", runtimeType: "static", outputDirectory: "app",
  requiredInputs: [], requiredUserInputs: [], warnings: [], blockers: [], secretEnvVars: ["DATABASE_URL"], environmentOwnership: [],
};
const planInputs = buildPlanWorkflowInputs(plan);
const decodedPlan = Buffer.from(planInputs.build_plan_base64, "base64").toString("utf8");
assert.deepEqual(JSON.parse(decodedPlan), plan, "build_plan_base64 is the canonical immutable BuildPlan payload");
assert.doesNotMatch(decodedPlan, /secret-value|password-value/, "BuildPlan contains secret names, never secret values");
assert.throws(() => buildPlanWorkflowInputs({ ...plan, environmentOwnership: [{ key: "DATABASE_URL", owner: "application", required: true, phase: "runtime", secret: true, repositoryValue: "secret-value" }] }), /BuildPlan must not contain secret environment values/);
const dispatched = githubWorkflowDispatchInputs({
  ...Object.fromEntries(GITHUB_ACTIONS_WORKFLOW_INPUTS.map(({ name }) => [name, "value"])),
  ...planInputs,
  rollback_source_operation_id: "", rollback_image_uri: "", rollback_task_definition_arn: "",
})!;
assert.equal(JSON.parse(dispatched.build_plan_contract_json).build_plan_base64, planInputs.build_plan_base64);
assert.equal(JSON.parse(dispatched.build_plan_contract_json).app_port, 8080, "number-typed reusable input stays numeric in the packed transport envelope");

const project = { id: "project", repositoryUrl: "https://github.com/owner/repo", repositoryFullName: "owner/repo", targetBranch: "main" };
const identity = (commitSha: string, branch = "main") => ({ repositoryFullName: "owner/repo", targetBranch: branch, commitSha, detectionStatus: DetectionStatus.SUCCESS });
const contract = (commitSha: string) => ({ commitSha, detectionSourceCommit: commitSha });
let detections = 0;
const same = await refreshDeploymentAnalysisIfStale({
  project, profile: identity("a"), contract: contract("a"), remoteCommit: "a",
  runAuthoritativeDetection: async () => { detections += 1; return { detectionStatus: DetectionStatus.SUCCESS }; },
  reload: async () => ({ project, profile: identity("a"), contract: contract("a") }), resolveRemoteCommit: async () => "a",
});
assert.equal(same.refreshed, false); assert.equal(detections, 0, "matching analysis is reused");

const refreshed = await refreshDeploymentAnalysisIfStale({
  project, profile: identity("a"), contract: contract("a"), remoteCommit: "b",
  runAuthoritativeDetection: async () => { detections += 1; return { detectionStatus: DetectionStatus.SUCCESS }; },
  reload: async () => ({ project, profile: identity("b"), contract: contract("b") }), resolveRemoteCommit: async () => "b",
});
assert.equal(refreshed.refreshed, true); assert.equal(refreshed.contract.commitSha, "b"); assert.equal(detections, 1, "stale analysis uses authoritative detection once");
assert.equal(evaluateBuildPlanReadiness(plan).status, "READY");
assert.equal(evaluateBuildPlanReadiness({ ...plan, requiredUserInputs: ["DATABASE_URL"] }).status, "INPUT_REQUIRED");
assert.equal(evaluateBuildPlanReadiness({ ...plan, blockers: ["Unsupported runtime"] }).status, "BLOCKED");

await assert.rejects(refreshDeploymentAnalysisIfStale({
  project, profile: identity("a"), contract: contract("a"), remoteCommit: "b",
  runAuthoritativeDetection: async () => ({ detectionStatus: DetectionStatus.SUCCESS }),
  reload: async () => ({ project: { ...project, targetBranch: "release" }, profile: identity("b", "release"), contract: contract("b") }), resolveRemoteCommit: async () => "b",
}), (error: any) => error?.response?.code === "deployment_identity_changed", "branch changes cannot mix analysis");
await assert.rejects(refreshDeploymentAnalysisIfStale({
  project, profile: identity("a"), contract: contract("a"), remoteCommit: "b",
  runAuthoritativeDetection: async () => ({ detectionStatus: DetectionStatus.SUCCESS }),
  reload: async () => ({ project, profile: identity("b"), contract: contract("b") }), resolveRemoteCommit: async () => "c",
}), (error: any) => error?.response?.code === "repository_advanced_during_analysis", "a second branch advance is bounded safely");

const deploymentSource = readFileSync(join(root, "backend/src/projects/github-actions-deployment.service.ts"), "utf8");
assert.match(deploymentSource, /runAuthoritativeDetection: \(\) => this\.deploymentProfiles\.runDetection/, "Deploy reuses the Detect Stack authority");
const dispatchSource = deploymentSource.slice(deploymentSource.indexOf("private async dispatch"), deploymentSource.indexOf("private async redispatch"));
assert.ok(dispatchSource.indexOf("ensureWorkflow") < dispatchSource.indexOf("refreshDeploymentAnalysisIfStale"), "managed caller mutation precedes final immutable commit binding");
console.log("Integrated deployment blocker checks passed: exact-pin workflow parity, canonical BuildPlan transport, local mismatch rejection, automatic stale refresh and concurrency fencing.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
