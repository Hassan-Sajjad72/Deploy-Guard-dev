import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  paginateWorkspaceReleaseHistory,
  parseWorkspaceReleaseHistoryFilters,
  summarizeWorkspaceReleaseLane,
  workspaceReleaseHistory,
  WORKSPACE_HISTORY_MAX_PAGE_SIZE,
} from "../src/projects/current-state/workspace-release-summary";

const summary = summarizeWorkspaceReleaseLane([
  { activeRunCount: 0, releaseLane: { state: "completed", stableRelease: { status: "stable", rollbackLineage: { revision: "6" } } } },
  { activeRunCount: 1, releaseLane: { state: "running", stableRelease: null } },
  { activeRunCount: 1, releaseLane: { state: "blocked", safeCodes: ["NORMAL_RELEASE_LANE_LEGACY_ACTIVITY_CONFLICT"], stableRelease: null } },
  { activeRunCount: 0, releaseLane: { state: "missing" } },
  { activeRunCount: 0, releaseLane: { state: "blocked", safeCodes: ["NORMAL_RELEASE_LANE_STATUS_BLOCKED"], stableRelease: null } },
]);

assert.deepEqual(summary, {
  activeRuns: 2,
  activeV1Releases: 1,
  completedV1Releases: 1,
  blockedOrFailedV1Releases: 2,
  stableProjects: 1,
  rollbackLineageProjects: 1,
  legacyOnlyProjects: 1,
  conflictingProjects: 1,
});
assert.equal(summarizeWorkspaceReleaseLane([null]).legacyOnlyProjects, 0);

const history = workspaceReleaseHistory([
  { projectId: "project-7", projectName: "Project-Tst", currentState: { releaseLane: { state: "completed", intent: { releaseManifestRevision: "7", sourceCommitShortSha: "4ef8326a48c6", lifecycleCode: "RELEASE_LANE_INTENT_COMPLETED", lastMeaningfulAt: "2026-07-27T12:00:00.000Z", history: [{ kind: "completed", code: "RELEASE_LANE_INTENT_COMPLETED", occurredAt: "2026-07-27T12:00:00.000Z" }] } } } as any },
  { projectId: "project-legacy", projectName: "Legacy", currentState: { releaseLane: { state: "missing" } } },
  { projectId: "project-conflict", projectName: "Conflict", currentState: { releaseLane: { state: "completed", safeCodes: ["NORMAL_RELEASE_LANE_STABLE_IDENTITY_CONFLICT"], intent: { releaseManifestRevision: "9", sourceCommitShortSha: "abcdef123456", lifecycleCode: "RELEASE_LANE_INTENT_COMPLETED", lastMeaningfulAt: "2026-07-27T13:00:00.000Z" } } } as any },
]);
assert.deepEqual(history.map((item) => [item.projectName, item.terminalState, item.candidateReleaseRevision]), [
  ["Conflict", "blocked", "9"],
  ["Project-Tst", "completed", "7"],
]);

const pagedHistory = workspaceReleaseHistory([
  ...history.map((item, index) => ({ projectId: `copy-${index}`, projectName: item.projectName, currentState: { releaseLane: { state: item.terminalState, intent: { releaseManifestRevision: item.candidateReleaseRevision, sourceCommitShortSha: item.sourceCommitShortSha, lifecycleCode: item.lifecycleCode, lastMeaningfulAt: item.occurredAt } } } as any })),
  { projectId: "project-newer", projectName: "Newer", currentState: { releaseLane: { state: "completed", intent: { releaseManifestRevision: "10", sourceCommitShortSha: "1234567", lifecycleCode: "RELEASE_LANE_INTENT_COMPLETED", lastMeaningfulAt: "2026-07-28T12:00:00.000Z" } } } as any },
  { projectId: "project-cancelled", projectName: "Cancelled", currentState: { releaseLane: { state: "cancelled", intent: { releaseManifestRevision: "8", sourceCommitShortSha: "7654321", lifecycleCode: "RELEASE_LANE_INTENT_CANCELLED", lastMeaningfulAt: "2026-07-26T12:00:00.000Z" } } } as any },
]);
const firstFilters = parseWorkspaceReleaseHistoryFilters({ historyLimit: "2" });
const firstPage = paginateWorkspaceReleaseHistory(pagedHistory, firstFilters);
const secondFilters = parseWorkspaceReleaseHistoryFilters({ historyLimit: "2", historyCursor: firstPage.nextCursor! });
const secondPage = paginateWorkspaceReleaseHistory(pagedHistory, secondFilters);
assert.deepEqual([...firstPage.items, ...secondPage.items].map((item) => item.projectName), ["Newer", "Conflict", "Project-Tst", "Cancelled"]);
assert.equal(new Set([...firstPage.items, ...secondPage.items].map((item) => item.projectName)).size, 4);
const shiftedAfterFirstPage = workspaceReleaseHistory([
  { projectId: "project-brand-new", projectName: "Brand New", currentState: { releaseLane: { state: "completed", intent: { releaseManifestRevision: "11", sourceCommitShortSha: "89abcde", lifecycleCode: "RELEASE_LANE_INTENT_COMPLETED", lastMeaningfulAt: "2026-07-29T12:00:00.000Z" } } } as any },
  ...pagedHistory.map((item, index) => ({ projectId: `shifted-${index}`, projectName: item.projectName, currentState: { releaseLane: { state: item.terminalState, intent: { releaseManifestRevision: item.candidateReleaseRevision, sourceCommitShortSha: item.sourceCommitShortSha, lifecycleCode: item.lifecycleCode, lastMeaningfulAt: item.occurredAt } } } as any })),
]);
const shiftedSecondPage = paginateWorkspaceReleaseHistory(shiftedAfterFirstPage, secondFilters);
assert.deepEqual(shiftedSecondPage.items.map((item) => item.projectName), ["Project-Tst", "Cancelled"]);
const equalTimestampHistory = workspaceReleaseHistory([
  { projectId: "same-a", projectName: "Alpha", currentState: { releaseLane: { state: "completed", intent: { releaseManifestRevision: "1", sourceCommitShortSha: "aaaaaaa", lifecycleCode: "RELEASE_LANE_INTENT_COMPLETED", lastMeaningfulAt: "2026-07-30T12:00:00.000Z" } } } as any },
  { projectId: "same-b", projectName: "Bravo", currentState: { releaseLane: { state: "completed", intent: { releaseManifestRevision: "1", sourceCommitShortSha: "bbbbbbb", lifecycleCode: "RELEASE_LANE_INTENT_COMPLETED", lastMeaningfulAt: "2026-07-30T12:00:00.000Z" } } } as any },
  { projectId: "same-c", projectName: "Charlie", currentState: { releaseLane: { state: "completed", intent: { releaseManifestRevision: "1", sourceCommitShortSha: "ccccccc", lifecycleCode: "RELEASE_LANE_INTENT_COMPLETED", lastMeaningfulAt: "2026-07-30T12:00:00.000Z" } } } as any },
]);
const equalPageOne = paginateWorkspaceReleaseHistory(equalTimestampHistory, parseWorkspaceReleaseHistoryFilters({ historyLimit: "2" }));
const equalPageTwo = paginateWorkspaceReleaseHistory(equalTimestampHistory, parseWorkspaceReleaseHistoryFilters({ historyLimit: "2", historyCursor: equalPageOne.nextCursor! }));
assert.deepEqual(equalPageOne.items.map((item) => item.projectName), ["Alpha", "Bravo"]);
assert.deepEqual(equalPageTwo.items.map((item) => item.projectName), ["Charlie"]);
assert.deepEqual(paginateWorkspaceReleaseHistory(pagedHistory, parseWorkspaceReleaseHistoryFilters({ historyState: "completed", historyProject: "project", historyFrom: "2026-07-27T00:00:00.000Z", historyTo: "2026-07-29T00:00:00.000Z" })).items.map((item) => item.projectName), ["Project-Tst"]);
for (const query of [
  { historyState: "running" },
  { historyProject: "x".repeat(81) },
  { historyFrom: "2026-07-27T00:00:00.000Z" },
  { historyFrom: "2026-01-01T00:00:00.000Z", historyTo: "2027-02-01T00:00:00.000Z" },
  { historyLimit: String(WORKSPACE_HISTORY_MAX_PAGE_SIZE + 1) },
  { historyCursor: "not-a-cursor" },
  { historyCursor: Buffer.from(JSON.stringify({ version: 1, filterKey: "[]", occurredAt: "2026-07-27T00:00:00.000Z", projectName: "X", terminalState: "completed", candidateReleaseRevision: null, sourceCommitShortSha: null, lifecycleCode: "RELEASE_LANE_INTENT_COMPLETED", tieBreaker: "abcdef123456" }), "utf8").toString("base64url") },
]) assert.throws(() => parseWorkspaceReleaseHistoryFilters(query));
assert.throws(() => parseWorkspaceReleaseHistoryFilters({ historyLimit: "2", historyCursor: firstPage.nextCursor!, historyState: "completed" }));

const controller = readFileSync(join(__dirname, "../src/projects/projects.controller.ts"), "utf8");
const projection = readFileSync(join(__dirname, "../src/projects/current-state/workspace-release-summary.ts"), "utf8");
assert.match(controller, /summarizeWorkspaceReleaseLane\(summaries\.map/);
assert.match(controller, /workspaceReleaseHistory\(summaries\.map/);
assert.match(controller, /paginateWorkspaceReleaseHistory/);
assert.match(controller, /usage: \{ \.\.\.usage, activeRuns: releaseSummary\.activeRuns \}/);
assert.doesNotMatch(projection, /(repository|manager)\.(save|update|insert|delete)\(|Dispatcher|Consumer|Terraform|ECS|AWS/);
console.log("Workspace release-summary verification passed");
