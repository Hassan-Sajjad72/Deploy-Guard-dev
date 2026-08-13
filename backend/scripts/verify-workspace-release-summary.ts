import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DeveloperProjectCurrentState } from "../src/projects/current-state/project-current-state.types";
import {
  paginateWorkspaceReleaseHistory,
  parseWorkspaceReleaseHistoryFilters,
  summarizeWorkspaceReleaseLane,
  workspaceReleaseHistory,
  WORKSPACE_HISTORY_MAX_PAGE_SIZE,
} from "../src/projects/current-state/workspace-release-summary";

function state(overrides: Partial<DeveloperProjectCurrentState> = {}): DeveloperProjectCurrentState {
  return {
    developerState: "ready", developerAction: "deploy", developerMessage: "Ready.",
    progress: { percentage: 0, phase: null, label: "Ready" }, repository: "owner/repo",
    branch: "main", commit: "a".repeat(40), latestAttempt: null, stableRelease: null,
    stableUrl: null, estimatedCost: null, missingConfiguration: [], applicationError: null,
    canRetry: false, ...overrides,
  };
}

const completed = state({
  developerState: "live", developerAction: "open_application",
  latestAttempt: { operationType: "deploy", status: "live", outcome: "completed", releaseRevision: "7", commit: "4ef8326a48c6", occurredAt: "2026-07-27T12:00:00.000Z" },
  stableRelease: { revision: "7", commit: "4ef8326a48c6", promotedAt: "2026-07-27T12:00:00.000Z", rollbackAvailable: true }, stableUrl: "https://app.example.test",
});
const summary = summarizeWorkspaceReleaseLane([
  completed,
  state({ developerState: "running" as never }),
  state({ developerState: "deploying", developerAction: "none" }),
  state({ developerState: "platform_attention", developerAction: "none", latestAttempt: { operationType: "deploy", status: "platform_attention", outcome: "blocked", releaseRevision: "9", commit: "abcdef123456", occurredAt: "2026-07-27T13:00:00.000Z" } }),
  state({ developerState: "failed_application", canRetry: true }),
]);
assert.deepEqual(summary, {
  activeRuns: 1,
  activeV1Releases: 1,
  completedV1Releases: 1,
  blockedOrFailedV1Releases: 2,
  stableProjects: 1,
  rollbackLineageProjects: 1,
});

const history = workspaceReleaseHistory([
  { projectId: "project-7", projectName: "Project-Tst", currentState: completed },
  { projectId: "project-ready", projectName: "Ready", currentState: state() },
  { projectId: "project-conflict", projectName: "Conflict", currentState: state({ developerState: "platform_attention", developerAction: "none", latestAttempt: { operationType: "deploy", status: "platform_attention", outcome: "blocked", releaseRevision: "9", commit: "abcdef123456", occurredAt: "2026-07-27T13:00:00.000Z" } }) },
]);
assert.deepEqual(history.map((item) => [item.projectName, item.terminalState, item.candidateReleaseRevision]), [["Conflict", "blocked", "9"], ["Project-Tst", "completed", "7"]]);
assert.equal(JSON.stringify(history).includes("lifecycleCode"), false);

const items = [
  ...history,
  { projectName: "Newer", terminalState: "completed" as const, candidateReleaseRevision: "10", sourceCommitShortSha: "1234567", occurredAt: "2026-07-28T12:00:00.000Z" },
  { projectName: "Cancelled", terminalState: "cancelled" as const, candidateReleaseRevision: "8", sourceCommitShortSha: "7654321", occurredAt: "2026-07-26T12:00:00.000Z" },
];
const first = paginateWorkspaceReleaseHistory(items, parseWorkspaceReleaseHistoryFilters({ historyLimit: "2" }));
const second = paginateWorkspaceReleaseHistory(items, parseWorkspaceReleaseHistoryFilters({ historyLimit: "2", historyCursor: first.nextCursor! }));
assert.deepEqual([...first.items, ...second.items].map((item) => item.projectName), ["Newer", "Conflict", "Project-Tst", "Cancelled"]);
const shifted = paginateWorkspaceReleaseHistory([
  { projectName: "Brand New", terminalState: "completed", candidateReleaseRevision: "11", sourceCommitShortSha: "89abcde", occurredAt: "2026-07-29T12:00:00.000Z" },
  ...items,
], parseWorkspaceReleaseHistoryFilters({ historyLimit: "2", historyCursor: first.nextCursor! }));
assert.deepEqual(shifted.items.map((item) => item.projectName), ["Project-Tst", "Cancelled"]);

const equalTimestamp = ["Alpha", "Bravo", "Charlie"].map((projectName, index) => ({ projectName, terminalState: "completed" as const, candidateReleaseRevision: "1", sourceCommitShortSha: `${"abc"[index]}aaaaaa`, occurredAt: "2026-07-30T12:00:00.000Z" }));
const equalOne = paginateWorkspaceReleaseHistory(equalTimestamp, parseWorkspaceReleaseHistoryFilters({ historyLimit: "2" }));
const equalTwo = paginateWorkspaceReleaseHistory(equalTimestamp, parseWorkspaceReleaseHistoryFilters({ historyLimit: "2", historyCursor: equalOne.nextCursor! }));
assert.deepEqual(equalOne.items.map((item) => item.projectName), ["Alpha", "Bravo"]);
assert.deepEqual(equalTwo.items.map((item) => item.projectName), ["Charlie"]);

for (const query of [
  { historyState: "running" }, { historyProject: "x".repeat(81) },
  { historyFrom: "2026-07-27T00:00:00.000Z" },
  { historyFrom: "2026-01-01T00:00:00.000Z", historyTo: "2027-02-01T00:00:00.000Z" },
  { historyLimit: String(WORKSPACE_HISTORY_MAX_PAGE_SIZE + 1) }, { historyCursor: "not-a-cursor" },
  { historyCursor: Buffer.from(JSON.stringify({ version: 2 }), "utf8").toString("base64url") },
]) assert.throws(() => parseWorkspaceReleaseHistoryFilters(query));

const controller = readFileSync(join(__dirname, "../src/projects/projects.controller.ts"), "utf8");
const projection = readFileSync(join(__dirname, "../src/projects/current-state/workspace-release-summary.ts"), "utf8");
assert.match(controller, /summarizeWorkspaceReleaseLane\(summaries\.map/);
assert.match(controller, /workspaceReleaseHistory\(summaries\.map/);
assert.match(controller, /usage: \{ \.\.\.usage, activeRuns: releaseSummary\.activeRuns \}/);
assert.doesNotMatch(projection, /lifecycleCode|safeCodes|releaseLane/);
assert.doesNotMatch(projection, /(repository|manager)\.(save|update|insert|delete)\(|Dispatcher|Consumer|Terraform|ECS|AWS/);
console.log("Sanitized workspace release-summary verification passed");
