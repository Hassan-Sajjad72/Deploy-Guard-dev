import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ForbiddenException } from "@nestjs/common";
import { projectDeveloperCurrentState } from "../src/projects/current-state/project-developer-current-state";
import { requireRole } from "../src/common/rbac/require-role.guard";
import { UserRole } from "../src/users/user.entity";
import { ProjectsService } from "../src/projects/projects.service";
import { ProjectStatus, ProjectVisibility } from "../src/projects/project.entity";

const base = {
  canManage: true,
  projectId: "raw-project-id",
  repositoryFullName: "acme/app",
  branch: "main",
  repository: { fullName: "acme/app", branch: "main" },
  deploymentContract: {
    deployable: true,
    commitSha: "a".repeat(40),
    buildCommand: "npm run build",
    startCommand: "npm start",
    missingEnvVars: [],
  },
  deploymentRequirements: { unresolvedInputKeys: [] },
  normalV1Availability: { mode: "shared", state: "authorized" },
  approvalState: { required: false, gate: null },
  progressPercentage: 0,
  releaseLane: { state: "missing", safeCodes: ["RAW_INTERNAL_CODE"] },
  cloudState: { accountId: "must-not-leak" },
  terraformStateSafety: { lockId: "must-not-leak" },
};

function project(overrides: Record<string, unknown>) {
  return projectDeveloperCurrentState({ ...base, ...overrides });
}

assert.deepEqual(
  Object.keys(project({})).sort(),
  [
    "applicationError", "branch", "canRetry", "commit", "developerAction",
    "developerMessage", "developerState", "estimatedCost", "latestAttempt",
    "missingConfiguration", "progress", "repository", "stableRelease", "stableUrl",
  ].sort(),
);
assert.equal(project({ canManage: false }).developerAction, "none");
assert.equal(project({ canManage: false, approvalState: { required: true, gate: "cost_gate" } }).developerAction, "none");

const stateFixtures = [
  { name: "ready", input: {}, expected: ["ready", "deploy"] },
  { name: "disabled", input: { releaseLane: { state: "disabled" } }, expected: ["platform_attention", "none"] },
  { name: "unsupported", input: { normalV1Availability: { mode: "shared", state: "unsupported" }, deploymentContract: { ...base.deploymentContract, deployable: false } }, expected: ["unsupported", "none"] },
  { name: "configuration", input: { deploymentRequirements: { unresolvedInputKeys: ["DATABASE_URL"] } }, expected: ["configuration_required", "provide_configuration"] },
  { name: "cost approval", input: { approvalState: { required: true, gate: "cost_gate" } }, expected: ["approval_required", "approve_cost"] },
  { name: "automatic cost approval", input: { releaseLane: { state: "prepared", intent: { infrastructurePlanning: { review: { approval: { state: "owner_required", required: true }, costEstimate: { state: "real", currency: "USD", monthlyCost: 30 } } } } } }, expected: ["approval_required", "approve_cost"] },
  { name: "broad change operator approval", input: { releaseLane: { state: "prepared", intent: { infrastructurePlanning: { review: { approval: { state: "operator_required", required: true }, costEstimate: { state: "real", currency: "USD", monthlyCost: 20 } } } } } }, expected: ["platform_attention", "none"] },
  { name: "prepared", input: { releaseLane: { state: "prepared", intent: {} } }, expected: ["preparing", "none"] },
  { name: "queued", input: { releaseLane: { state: "queued", intent: {} } }, expected: ["queued", "none"] },
] as const;
for (const fixture of stateFixtures) {
  const result = project(fixture.input);
  assert.deepEqual([result.developerState, result.developerAction], fixture.expected, fixture.name);
}
assert.deepEqual(
  project({ deploymentRequirements: { unresolvedInputKeys: ["DATABASE_URL", "API_KEY"] } }).missingConfiguration,
  ["API_KEY", "DATABASE_URL"],
);

for (const [phase, expected] of [["analyze", "preparing"], ["build", "building"], ["prepare", "preparing"], ["deploy", "deploying"], ["verify", "verifying"]] as const) {
  const result = project({ releaseLane: { state: "running", intent: { operation: { phases: [{ key: phase, status: "running" }] } } } });
  assert.equal(result.developerState, expected);
  assert.equal(result.developerAction, "none");
}

const reconciling = project({
  releaseLane: {
    state: "reconciling",
    intent: {
      sourceCommitShortSha: "a".repeat(12),
      lastMeaningfulAt: "2026-08-01T12:00:00.000Z",
      operation: {
        latestAttempt: { status: "reconciling", releaseRevision: "2" },
        phases: [{ key: "analyze", label: "Analyze", status: "running" }],
      },
    },
  },
});
assert.equal(reconciling.developerState, "verifying");
assert.equal(reconciling.developerAction, "none");
assert.match(reconciling.developerMessage, /verifying the deployment/i);

const stable = {
  revision: "7",
  sourceCommitShortSha: "a".repeat(12),
  status: "stable",
  promotedAt: "2026-07-30T12:00:00.000Z",
  url: "https://app.example.test",
  rollbackLineage: { revision: "6" },
};
const live = project({
  releaseLane: {
    state: "completed",
    intent: { releaseManifestRevision: "7", sourceCommitShortSha: "a".repeat(12), lastMeaningfulAt: "2026-07-30T12:00:00.000Z" },
    stableRelease: stable,
  },
});
assert.equal(live.developerState, "live");
assert.equal(live.developerAction, "open_application");
assert.equal(live.stableUrl, "https://app.example.test/");
assert.equal(live.stableRelease?.rollbackAvailable, true);

const newer = project({
  deploymentContract: { ...base.deploymentContract, commitSha: "b".repeat(40) },
  releaseLane: { state: "completed", intent: { releaseManifestRevision: "7", sourceCommitShortSha: "a".repeat(12), lastMeaningfulAt: "2026-07-30T12:00:00.000Z" }, stableRelease: stable },
});
assert.equal(newer.developerState, "ready");
assert.equal(newer.developerAction, "redeploy");

const buildFailure = project({
  releaseLane: {
    state: "blocked",
    intent: { operation: { terminalResult: "failed", phases: [{ key: "build", status: "failed" }] } },
  },
});
assert.equal(buildFailure.developerState, "failed_application");
assert.equal(buildFailure.applicationError?.category, "build");
assert.equal(buildFailure.canRetry, true);

const platformConflict = project({
  releaseLane: { state: "blocked", safeCodes: ["NORMAL_RELEASE_LANE_STABLE_IDENTITY_CONFLICT"], intent: {} },
});
assert.equal(platformConflict.developerState, "platform_attention");
assert.equal(platformConflict.developerAction, "none");

const cleanExpressPreExecutionRetry = project({
  projectId: "7ff60e82-e166-4d3b-9ea7-78203370e59f",
  repositoryFullName: "render-examples/express-hello-world",
  branch: "main",
  existingState: null,
  deploymentContract: {
    ...base.deploymentContract,
    commitSha: "039c34770852fb07cef7f9f0f8534c5de408b207",
    startCommand: "yarn start",
    port: 3001,
    missingEnvVars: [],
  },
  deploymentRequirements: { unresolvedInputKeys: [] },
  releaseLane: {
    state: "blocked",
    safeCodes: ["FIRST_RELEASE_PRE_EXECUTION_RETRY_READY"],
    intent: {
      sourceCommitShortSha: "039c34770852",
      lastMeaningfulAt: "2026-08-01T13:23:33.993Z",
    },
  },
});
assert.equal(cleanExpressPreExecutionRetry.developerState, "ready");
assert.equal(cleanExpressPreExecutionRetry.developerAction, "deploy");
assert.equal(cleanExpressPreExecutionRetry.missingConfiguration.length, 0);
assert.equal(cleanExpressPreExecutionRetry.stableRelease, null);

const retryWithAmbiguousProviderState = project({
  existingState: { classification: "ambiguous" },
  releaseLane: {
    state: "blocked",
    safeCodes: ["FIRST_RELEASE_PRE_EXECUTION_RETRY_READY"],
    intent: {},
  },
});
assert.equal(retryWithAmbiguousProviderState.developerState, "platform_attention");
assert.equal(retryWithAmbiguousProviderState.developerAction, "none");

const identityConflict = project({
  releaseLane: {
    state: "completed",
    intent: { releaseManifestRevision: "7", sourceCommitShortSha: "b".repeat(12), lastMeaningfulAt: "2026-07-30T12:00:00.000Z" },
    stableRelease: stable,
  },
});
assert.equal(identityConflict.developerState, "platform_attention");
assert.equal(identityConflict.latestAttempt?.outcome, "blocked");

const localFixture = project({
  localExecutionAuthorized: true,
  existingState: { classification: "ambiguous" },
  releaseLane: { state: "missing", stableRelease: stable },
});
assert.notEqual(localFixture.developerState, "platform_attention");
assert.equal("localExecutionAuthorized" in localFixture, false);
assert.equal(identityConflict.stableUrl, "https://app.example.test/");

const invalidUrl = project({
  releaseLane: { state: "completed", intent: { sourceCommitShortSha: "a".repeat(12) }, stableRelease: { ...stable, url: "file:///etc/passwd" } },
});
assert.equal(invalidUrl.stableUrl, null);
assert.equal(invalidUrl.developerAction, "none");

const operatorReview = project({
  existingState: {
    classification: "ambiguous",
    safeCode: "MUST_NOT_LEAK",
    operatorAction: "clean_verified_residue",
    cleanupAllowed: false,
  },
  releaseLane: {
    state: "completed",
    intent: { releaseManifestRevision: "7", sourceCommitShortSha: "a".repeat(12), lastMeaningfulAt: "2026-07-30T12:00:00.000Z" },
    stableRelease: stable,
  },
});
assert.equal(operatorReview.developerState, "platform_attention");
assert.equal(operatorReview.developerAction, "none");
assert.equal(operatorReview.stableUrl, null, "unverified cloud state must not expose a live URL");
assert.equal(JSON.stringify(operatorReview).includes("MUST_NOT_LEAK"), false);
assert.equal(JSON.stringify(operatorReview).includes("clean_verified_residue"), false);

const disabledDrain = project({
  normalV1Availability: {
    mode: "shared",
    state: "unavailable",
    safeCode: "NORMAL_V1_DURABLE_OUTBOX_DRAIN_UNAVAILABLE",
  },
  releaseLane: { state: "missing" },
});
assert.equal(disabledDrain.developerState, "platform_attention");
assert.equal(disabledDrain.developerAction, "none");
assert.equal(JSON.stringify(disabledDrain).includes("DURABLE_OUTBOX"), false);

const serialized = JSON.stringify(live);
for (const forbiddenKey of ["projectId", "safeCodes", "lifecycleCode", "outbox", "terraform", "accountId", "worker", "lease", "owner", "fence"]) {
  assert.equal(serialized.toLowerCase().includes(`\"${forbiddenKey.toLowerCase()}\"`), false, `${forbiddenKey} key leaked`);
}
for (const forbiddenValue of ["raw-project-id", "raw_internal_code", "must-not-leak"]) {
  assert.equal(serialized.toLowerCase().includes(forbiddenValue), false, `${forbiddenValue} value leaked`);
}

const controller = readFileSync(resolve(__dirname, "../src/projects/projects.controller.ts"), "utf8");
const service = readFileSync(resolve(__dirname, "../src/projects/current-state/project-current-state.service.ts"), "utf8");
assert.match(controller, /@Get\(":projectId\/current-state\/details"\)[\s\S]*?@UseGuards\(requireRole\(\[UserRole\.ADMIN\]\)\)/);
assert.match(controller, /@Get\(":projectId\/current-state\/existing-state"\)[\s\S]*?@UseGuards\(requireRole\(\[UserRole\.ADMIN\]\)\)/);
assert.match(controller, /@Get\(":projectId\/release-lane\/status"\)[\s\S]*?@UseGuards\(requireRole\(\[UserRole\.ADMIN\]\)\)/);
assert.match(service, /getCurrentState[\s\S]*projectDeveloperCurrentState/);
assert.match(service, /getDetailedCurrentState/);

const DetailedGuard = requireRole([UserRole.ADMIN]);
const guard = new DetailedGuard();
const context = (role: UserRole) => ({ switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }) }) as never;
assert.throws(() => guard.canActivate(context(UserRole.DEVELOPER)), ForbiddenException);
assert.throws(() => guard.canActivate(context(UserRole.READONLY)), ForbiddenException);
assert.equal(guard.canActivate(context(UserRole.ADMIN)), true);

const foreignProject = {
  id: "11111111-1111-4111-8111-111111111111",
  ownerUserId: 41,
  status: ProjectStatus.CREATED,
  visibility: ProjectVisibility.PRIVATE,
};
const projectsService = Reflect.construct(ProjectsService, [
  { findOne: async () => foreignProject },
  ...Array(12).fill(undefined),
]) as ProjectsService;
async function verifyProjectIsolation() {
  await assert.rejects(
    projectsService.getProjectEntityForView({ id: 42, role: UserRole.DEVELOPER } as never, foreignProject.id),
    ForbiddenException,
  );
}

verifyProjectIsolation()
  .then(() => console.log("Canonical developer current-state projection and operator authorization verification passed."))
  .catch((error) => { console.error(error); process.exitCode = 1; });
