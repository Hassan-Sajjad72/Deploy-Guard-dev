import { strict as assert } from "assert";
import { deploymentContractMatchesIdentity } from "../src/projects/deployment-contract-identity";
import { readFileSync } from "fs";

const controller = readFileSync("src/projects/projects.controller.ts", "utf8");
const deployment = readFileSync("src/projects/github-actions-deployment.service.ts", "utf8");
const operationContract = readFileSync("src/projects/github-actions-operation-contract.ts", "utf8");
const profileService = readFileSync("src/projects/detection/deployment-profile.service.ts", "utf8");

const detectionStart = controller.indexOf('async detectStack');
const detectionEnd = controller.indexOf('@Get(":projectId/detection-profile")');
const detection = controller.slice(detectionStart, detectionEnd);
assert.ok(detectionStart >= 0 && detectionEnd > detectionStart, "detect-stack route must exist");
assert.ok(detection.indexOf("runDetection") < detection.indexOf("ensureDeployguardWorkflow"), "detection must finish before any workflow mutation");
assert.match(detection, /contract\?\.deployable\s*\?\s*await this\.projectsService\.ensureDeployguardWorkflow/);
assert.match(deployment, /let contract = await this\.deploymentContracts\.requireForProject\(projectId\);/);
assert.match(deployment, /this\.deploymentContracts\.assertDeployable\(contract, project\);/);

const dispatchStart = deployment.indexOf("private async dispatch");
const dispatchEnd = deployment.indexOf("private safeOutputDirectory");
const dispatch = deployment.slice(dispatchStart, dispatchEnd);
assert.ok(dispatchStart >= 0 && dispatchEnd > dispatchStart, "GitHub Actions dispatch boundary must exist");
assert.match(dispatch, /if \(action === "deploy"\)/);
assert.match(dispatch, /assertInitialGithubActionsIdentity\(project, profile!?, contract, remoteCommit\)/);
assert.match(operationContract, /profile\.commitSha !== contract\.commitSha/);
assert.match(operationContract, /contract\.detectionSourceCommit !== contract\.commitSha/);
assert.match(dispatch, /repositoryWorkspace\.resolveRemoteCommit/);
assert.match(operationContract, /remoteCommit !== contract\.commitSha/);
assert.ok(dispatch.indexOf("ensureWorkflow") < dispatch.indexOf("resolveRemoteCommit"), "managed caller compatibility/update must precede final commit binding");
assert.ok(dispatch.indexOf("resolveRemoteCommit") < dispatch.indexOf("runRepository.save"), "stale detection must be rejected before operation persistence");
assert.match(dispatch, /refreshDeploymentAnalysisIfStale/);
assert.match(dispatch, /runAuthoritativeDetection: \(\) => this\.deploymentProfiles\.runDetection/);
assert.match(profileService, /repositoryFullName: project\.repositoryFullName/);
assert.match(profileService, /targetBranch: project\.targetBranch/);
assert.match(profileService, /inputFingerprint: detectionFingerprint\(project, draft\.commitSha\)/);
assert.match(controller, /getMatchingForProject/);

const commitA = "a".repeat(40);
const commitB = "b".repeat(40);
const contractIdentity = {
  repositoryFullName: "Example/Application",
  branch: "master",
  commitSha: commitB,
  detectionSourceCommit: commitB,
  buildPlan: { repositoryFullName: "Example/Application", branch: "master", commitSha: commitB },
};
assert.equal(deploymentContractMatchesIdentity(contractIdentity, { repositoryFullName: "example/application", targetBranch: "master", commitSha: commitB }), true);
assert.equal(deploymentContractMatchesIdentity(contractIdentity, { repositoryFullName: "example/application", targetBranch: "main", commitSha: commitB }), false, "branch A contract cannot satisfy branch B");
assert.equal(deploymentContractMatchesIdentity(contractIdentity, { repositoryFullName: "example/application", targetBranch: "master", commitSha: commitA }), false, "advanced branch commit requires fresh analysis");
assert.equal(deploymentContractMatchesIdentity(contractIdentity, { repositoryFullName: "another/application", targetBranch: "master", commitSha: commitB }), false, "repository identity is mandatory");

console.log("Detection contract gate verification passed.");
