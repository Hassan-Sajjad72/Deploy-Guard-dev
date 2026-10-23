import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePipelineActivity } from "../src/projects/pipeline/pipeline-activity.service";
import { ProjectActivityService } from "../src/projects/project-activity.service";
import { rankWorkspaceSummaries } from "../src/projects/project-recency";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";
import { ProjectCurrentStateService } from "../src/projects/current-state/project-current-state.service";

const project = (id: string, name: string, meaningful: string, viewed: string, state: Record<string, unknown> = {}) => ({
  project: { id, name, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-22T23:59:00.000Z", activity: { lastMeaningfulActivityAt: meaningful, lastViewedAt: viewed, lastRoute: `/projects/${id}/requirements`, pinned: false } },
  currentState: { overallStatus: "ready", deploymentStatus: "not_deployed", healthStatus: "unknown", cloudVerificationStatus: "verified", activitySnapshot: { isActive: false }, ...state },
});

const cattle = project("cattle", "Cattle Form", "2026-07-22T10:00:00.000Z", "2026-07-22T10:01:00.000Z", { overallStatus: "failed", deploymentStatus: "unhealthy", lastFailureAt: "2026-07-22T09:55:00.000Z" });
const projectTst = project("test", "Project-Tst", "2026-07-21T10:00:00.000Z", "2026-07-22T11:00:00.000Z", { lastCloudVerifiedAt: "2026-07-22T12:00:00.000Z" });
let ranked = rankWorkspaceSummaries([projectTst, cattle] as any);
assert.equal(ranked.continueWorking?.project.id, "cattle", "recent page view or background verification must not replace later meaningful work");
assert.equal(ranked.recentlyViewed[0].project.id, "test", "page views belong only to Recently viewed");
assert.equal(ranked.attention[0].project.id, "cattle", "failed project remains in Needs attention");
assert.equal(ranked.continueWorking?.project.activity?.lastRoute, "/projects/cattle/requirements");

const savedCattle = project("cattle", "Cattle Form", "2026-07-22T13:00:00.000Z", "2026-07-22T10:01:00.000Z");
ranked = rankWorkspaceSummaries([projectTst, savedCattle] as any);
assert.equal(ranked.continueWorking?.project.id, "cattle", "saving requirements moves the project to the top");
const activeOlder = project("active", "Active", "2026-07-20T00:00:00.000Z", "2026-07-20T00:00:00.000Z", { activitySnapshot: { isActive: true } });
assert.equal(rankWorkspaceSummaries([savedCattle, activeOlder] as any).ordered[0].project.id, "active", "active pipeline ranks first");
const otherUsersActive = project("other-active", "Other active", "2026-07-20T00:00:00.000Z", "2026-07-20T00:00:00.000Z", { activitySnapshot: { isActive: true, activityType: "deployment", triggeredByUserId: 2 } });
assert.equal(rankWorkspaceSummaries([savedCattle, otherUsersActive] as any, 1).continueWorking?.project.id, "cattle", "another user's active pipeline must not replace this user's meaningful work");
const ownActive = project("own-active", "Own active", "2026-07-20T00:00:00.000Z", "2026-07-20T00:00:00.000Z", { activitySnapshot: { isActive: true, activityType: "deployment", triggeredByUserId: 1 } });
assert.equal(rankWorkspaceSummaries([savedCattle, ownActive] as any, 1).continueWorking?.project.id, "own-active", "the user's own active pipeline becomes Continue working");

const noBullJob = resolvePipelineActivity({
  projectId: "cattle",
  latestRun: { id: "old", projectId: "cattle", status: PipelineRunStatus.RUNNING, currentStage: "terraform_apply", currentStageStartedAt: new Date("2026-07-20T00:00:00Z"), triggeredByUserId: 1, createdAt: new Date("2026-07-20T00:00:00Z"), updatedAt: new Date("2026-07-20T00:00:00Z"), startedAt: new Date("2026-07-20T00:00:00Z") },
  queueJobs: [], queueCheckAvailable: true, staleAfterMs: 900_000, nowMs: Date.parse("2026-07-22T00:00:00Z"),
});
assert.equal(noBullJob.isActive, false);
assert.equal(noBullJob.stage, null);
assert.match(noBullJob.displayMessage, /no active deployment job/i);
const currentStatePrototype = Object.create(ProjectCurrentStateService.prototype) as any;
const recoveryActivity = currentStatePrototype.canonicalActivitySnapshot(noBullJob, { recoveryActive: true, recoveryStartedAt: instant("2026-07-22T01:00:00Z"), activePipelineRunId: null, authoritativeTimestamp: instant("2026-07-22T01:01:00Z"), queueActive: false }, { evidence: {} });
assert.equal(recoveryActivity.activityType, "recovery");
const cleanupActivity = currentStatePrototype.canonicalActivitySnapshot(noBullJob, { recoveryActive: false, queueActive: false }, { evidence: { latestDestroyStatus: "running", latestDestroyStartedAt: instant("2026-07-22T02:00:00Z") } });
assert.equal(cleanupActivity.activityType, "cleanup");

const queries: string[] = [];
const activity = new ProjectActivityService({ query: async (sql: string) => { queries.push(sql); }, find: async () => [] } as any);
void activity.recordView(1, "cattle", { route: "/projects/cattle/pipeline", section: "pipeline" });
assert.doesNotMatch(queries[0], /last_meaningful_activity_at\s*=/i, "page view must not update meaningful activity");
void activity.recordUserAction(1, "cattle", "requirements_saved", { route: "/projects/cattle/requirements", section: "requirements" });
assert.match(queries[1], /last_meaningful_activity_at/i);

const projectsService = readFileSync(join(__dirname, "../src/projects/projects.service.ts"), "utf8");
const projectsController = readFileSync(join(__dirname, "../src/projects/projects.controller.ts"), "utf8");
const pipelineController = projectsController;
const currentState = readFileSync(join(__dirname, "../src/projects/current-state/project-current-state.service.ts"), "utf8");
const pipelineService = readFileSync(join(__dirname, "../src/projects/pipeline/pipeline.service.ts"), "utf8");
const migration = readFileSync(join(__dirname, "../src/migrations/1760000030000-CanonicalProjectTimeAndRecency.ts"), "utf8");
const recency = readFileSync(join(__dirname, "../src/projects/project-recency.ts"), "utf8");
const stateController = readFileSync(join(__dirname, "../src/state-management/state-management.controller.ts"), "utf8");
const storageController = readFileSync(join(__dirname, "../src/storage/storage.controller.ts"), "utf8");
const orchestrationController = readFileSync(join(__dirname, "../src/orchestration/orchestration.controller.ts"), "utf8");
assert.match(projectsService, /EXISTING_PROJECT/);
assert.match(projectsService, /githubRepositoryId[\s\S]*targetBranch[\s\S]*environmentName/);
assert.doesNotMatch(recency, /project\.updatedAt/);
assert.match(projectsController, /creationWarnings/);
const retiredRetryController = pipelineController.match(/async retryPipelineRun[\s\S]{0,800}/)?.[0] || "";
assert.match(retiredRetryController, /GoneException/, "legacy retry must fail closed after execution-path retirement");
assert.doesNotMatch(retiredRetryController, /startAutomation/, "legacy retry must not invoke the retired automation path");
assert.doesNotMatch(pipelineController.match(/retryPipelineRun[\s\S]{0,800}/)?.[0] || "", /createProject/);
for (const method of ["executeRecoveryResume", "cancelPipelineRun", "retryPipelineRun", "approveTerraformApply"]) {
  const source = pipelineController.match(new RegExp(`async ${method}[\\s\\S]{0,900}`))?.[0] || "";
  assert.match(source, /GoneException/, `${method} must not expose a legacy developer mutation`);
}
for (const [source, route] of [
  [stateController, "recover"],
  [stateController, "forceRelease"],
  [storageController, "provision"],
  [storageController, "createRestoreRequest"],
  [orchestrationController, "rollback"],
  [orchestrationController, "updateScaling"],
] as const) {
  const guarded = source.slice(Math.max(0, source.indexOf(`async ${route}`) - 120), source.indexOf(`async ${route}`) + 120);
  assert.match(guarded, /UserRole\.ADMIN/, `${route} must remain operator/admin-only`);
  assert.doesNotMatch(guarded, /UserRole\.DEVELOPER/, `${route} must not be developer-executable`);
}
assert.match(currentState, /failedProjectContinuity/);
assert.match(currentState, /lastCloudVerificationAt/);
assert.match(currentState, /activitySnapshot/);
assert.match(pipelineService, /order: \{ occurredAt: "ASC", sequenceNumber: "ASC" \}/);
assert.match(migration, /UQ_active_project_repository_branch_environment/);
assert.match(migration, /legacy-/);
assert.match(migration, /project_user_activity/);
assert.match(migration, /deployguard_set_pipeline_event_sequence/);

console.log("Project continuity verification passed (meaningful recency, views, active authority, failed continuity, duplicate identity, and canonical event ordering).\n");

function instant(value: string) { return value; }
