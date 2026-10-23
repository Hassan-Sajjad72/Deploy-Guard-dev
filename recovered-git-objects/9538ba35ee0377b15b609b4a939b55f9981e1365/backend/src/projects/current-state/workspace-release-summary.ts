import { createHash } from "crypto";

type ReleaseLane = {
  state?: string;
  safeCodes?: readonly string[];
  stableRelease?: { status?: string; rollbackLineage?: unknown } | null;
} | null | undefined;

type WorkspaceState = {
  activeRunCount?: number;
  releaseLane?: ReleaseLane;
} | null | undefined;

type WorkspaceReleaseHistoryCursor = {
  version: 2;
  filterKey: string;
  occurredAt: string;
  projectName: string;
  terminalState: WorkspaceReleaseHistoryItem["terminalState"];
  candidateReleaseRevision: string | null;
  sourceCommitShortSha: string | null;
  lifecycleCode: string;
  tieBreaker: string;
};

type WorkspaceReleaseHistoryEntry = WorkspaceReleaseHistoryItem & {
  tieBreaker: string;
};

export type WorkspaceReleaseHistoryInput = {
  projectId: string;
  projectName: string;
  currentState: WorkspaceState;
};

export type WorkspaceReleaseHistoryItem = {
  projectName: string;
  terminalState: "completed" | "cancelled" | "blocked";
  candidateReleaseRevision: string | null;
  sourceCommitShortSha: string | null;
  lifecycleCode: string;
  occurredAt: string;
};

export type WorkspaceReleaseHistoryFilters = {
  terminalState: WorkspaceReleaseHistoryItem["terminalState"] | null;
  projectName: string | null;
  from: string | null;
  to: string | null;
  limit: number;
  cursor: WorkspaceReleaseHistoryCursor | null;
};

export type WorkspaceReleaseHistoryPage = {
  items: WorkspaceReleaseHistoryItem[];
  nextCursor: string | null;
  limit: number;
};

export type WorkspaceReleaseSummary = {
  activeRuns: number;
  activeV1Releases: number;
  completedV1Releases: number;
  blockedOrFailedV1Releases: number;
  stableProjects: number;
  rollbackLineageProjects: number;
  legacyOnlyProjects: number;
  conflictingProjects: number;
};

const ACTIVE_V1_STATES = new Set(["prepared", "queued", "running"]);
const CONFLICT_CODES = new Set([
  "NORMAL_RELEASE_LANE_LEGACY_ACTIVITY_CONFLICT",
  "NORMAL_RELEASE_LANE_STABLE_IDENTITY_CONFLICT",
]);
const TERMINAL_STATES = new Set(["completed", "cancelled", "blocked"]);
export const WORKSPACE_HISTORY_MAX_PAGE_SIZE = 8;
const WORKSPACE_HISTORY_DEFAULT_PAGE_SIZE = 5;
const WORKSPACE_HISTORY_MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1_000;

/** Pure aggregation of the sanitized current-state projection; no lifecycle reads or writes. */
export function summarizeWorkspaceReleaseLane(states: readonly WorkspaceState[]): WorkspaceReleaseSummary {
  return states.reduce<WorkspaceReleaseSummary>((summary, state) => {
    // A failed per-project read is not legacy evidence. Exclude it rather than
    // fabricating a safe-looking fallback in workspace totals.
    if (!state) return summary;
    const lane = state?.releaseLane;
    const conflict = Boolean(lane?.safeCodes?.some((code) => CONFLICT_CODES.has(code)));
    const hasV1Evidence = Boolean(lane && !["disabled", "missing"].includes(lane.state || ""));
    const activeRuns = Number.isInteger(state?.activeRunCount) && (state?.activeRunCount || 0) > 0
      ? state!.activeRunCount!
      : 0;
    summary.activeRuns += activeRuns;
    if (!hasV1Evidence) {
      summary.legacyOnlyProjects += 1;
      return summary;
    }
    if (conflict) {
      summary.conflictingProjects += 1;
      summary.blockedOrFailedV1Releases += 1;
      return summary;
    }
    if (ACTIVE_V1_STATES.has(lane?.state || "")) summary.activeV1Releases += 1;
    if (lane?.state === "completed") summary.completedV1Releases += 1;
    if (lane?.state === "blocked") summary.blockedOrFailedV1Releases += 1;
    if (lane?.stableRelease?.status === "stable") summary.stableProjects += 1;
    if (lane?.stableRelease?.rollbackLineage) summary.rollbackLineageProjects += 1;
    return summary;
  }, {
    activeRuns: 0,
    activeV1Releases: 0,
    completedV1Releases: 0,
    blockedOrFailedV1Releases: 0,
    stableProjects: 0,
    rollbackLineageProjects: 0,
    legacyOnlyProjects: 0,
    conflictingProjects: 0,
  });
}

/** Bounded terminal-only history, built from the same sanitized current-state evidence. */
export function workspaceReleaseHistory(inputs: readonly WorkspaceReleaseHistoryInput[]): WorkspaceReleaseHistoryItem[] {
  const byProject = new Map<string, WorkspaceReleaseHistoryEntry>();
  for (const input of inputs) {
    const lane = input.currentState?.releaseLane as any;
    if (!lane || ["disabled", "missing"].includes(lane.state)) continue;
    const conflictCode = lane.safeCodes?.find((code: string) => CONFLICT_CODES.has(code));
    const state = conflictCode ? "blocked" : lane.state;
    if (!TERMINAL_STATES.has(state)) continue;
    const intent = lane.intent;
    const terminalEvent = Array.isArray(intent?.history)
      ? [...intent.history].reverse().find((event: any) => event?.kind === state && safeTimestamp(event.occurredAt))
      : null;
    const occurredAt = terminalEvent?.occurredAt || (safeTimestamp(intent?.lastMeaningfulAt) ? intent.lastMeaningfulAt : null);
    const lifecycleCode = conflictCode || terminalEvent?.code || intent?.lifecycleCode;
    if (!safeProjectName(input.projectName) || !safeTimestamp(occurredAt) || !safeCode(lifecycleCode)) continue;
    byProject.set(input.projectId, {
      projectName: input.projectName,
      terminalState: state,
      candidateReleaseRevision: safeRevision(intent?.releaseManifestRevision),
      sourceCommitShortSha: safeSha(intent?.sourceCommitShortSha),
      lifecycleCode,
      occurredAt,
      // Stable, non-sensitive final ordering key. It never leaves the opaque cursor.
      tieBreaker: makeTieBreaker(input.projectId),
    });
  }
  return [...byProject.values()]
    .sort(compareHistoryEntries)
    .map((item) => item as WorkspaceReleaseHistoryItem);
}

/**
 * Parses query values without accepting raw identifiers or unbounded scans.
 * The opaque cursor carries the normalized filter key plus the last emitted keyset tuple.
 */
export function parseWorkspaceReleaseHistoryFilters(query: Record<string, unknown>): WorkspaceReleaseHistoryFilters {
  const allowed = new Set(["historyState", "historyProject", "historyFrom", "historyTo", "historyLimit", "historyCursor"]);
  if (Object.keys(query).some((key) => !allowed.has(key))) throw new Error("invalid_history_filters");
  const state = optionalQueryString(query.historyState);
  const projectName = optionalQueryString(query.historyProject);
  const from = optionalQueryString(query.historyFrom);
  const to = optionalQueryString(query.historyTo);
  const cursor = optionalQueryString(query.historyCursor);
  const limitValue = optionalQueryString(query.historyLimit);

  if (state && !TERMINAL_STATES.has(state)) throw new Error("invalid_history_filters");
  if (projectName && (!safeProjectName(projectName) || projectName.length > 80)) throw new Error("invalid_history_filters");
  if (Boolean(from) !== Boolean(to) || (from && (!safeTimestamp(from) || !safeTimestamp(to)))) throw new Error("invalid_history_filters");
  if (from && to && (Date.parse(to) < Date.parse(from) || Date.parse(to) - Date.parse(from) > WORKSPACE_HISTORY_MAX_WINDOW_MS)) {
    throw new Error("invalid_history_filters");
  }
  const limit = limitValue ? Number(limitValue) : WORKSPACE_HISTORY_DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > WORKSPACE_HISTORY_MAX_PAGE_SIZE) throw new Error("invalid_history_filters");

  const normalizedProjectName = projectName ? projectName.trim().replace(/\s+/g, " ") : null;
  const base = { terminalState: state as WorkspaceReleaseHistoryItem["terminalState"] | null, projectName: normalizedProjectName, from: from || null, to: to || null, limit };
  const decoded = cursor ? decodeCursor(cursor) : null;
  if (decoded && decoded.filterKey !== filterKey(base)) throw new Error("invalid_history_filters");
  return { ...base, cursor: decoded };
}

export function paginateWorkspaceReleaseHistory(
  items: readonly WorkspaceReleaseHistoryItem[],
  filters: WorkspaceReleaseHistoryFilters,
): WorkspaceReleaseHistoryPage {
  const filtered = items
    .map(enrichHistoryEntry)
    .filter((item) => {
    if (filters.terminalState && item.terminalState !== filters.terminalState) return false;
    if (filters.projectName && !item.projectName.toLocaleLowerCase().includes(filters.projectName.toLocaleLowerCase())) return false;
    if (filters.from && Date.parse(item.occurredAt) < Date.parse(filters.from)) return false;
    return !(filters.to && Date.parse(item.occurredAt) > Date.parse(filters.to));
  })
    .sort(compareHistoryEntries);
  const paged = filters.cursor
    ? filtered.filter((item) => compareEntryToCursor(item, filters.cursor!) > 0)
    : filtered;
  const page = paged.slice(0, filters.limit);
  const last = page.at(-1) || null;
  return {
    items: page.map(({ tieBreaker: _tieBreaker, ...item }) => item),
    limit: filters.limit,
    nextCursor: last && paged.length > page.length ? encodeCursor(toCursor(last, filterKey(filters))) : null,
  };
}

function compareHistoryEntries(left: WorkspaceReleaseHistoryEntry, right: WorkspaceReleaseHistoryEntry) {
  return Date.parse(right.occurredAt) - Date.parse(left.occurredAt)
    || left.projectName.localeCompare(right.projectName)
    || left.terminalState.localeCompare(right.terminalState)
    || (left.candidateReleaseRevision || "").localeCompare(right.candidateReleaseRevision || "")
    || (left.sourceCommitShortSha || "").localeCompare(right.sourceCommitShortSha || "")
    || left.lifecycleCode.localeCompare(right.lifecycleCode)
    || left.tieBreaker.localeCompare(right.tieBreaker);
}

function compareEntryToCursor(entry: WorkspaceReleaseHistoryEntry, cursor: WorkspaceReleaseHistoryCursor) {
  return compareHistoryEntries(entry, {
    projectName: cursor.projectName,
    terminalState: cursor.terminalState,
    candidateReleaseRevision: cursor.candidateReleaseRevision,
    sourceCommitShortSha: cursor.sourceCommitShortSha,
    lifecycleCode: cursor.lifecycleCode,
    occurredAt: cursor.occurredAt,
    tieBreaker: cursor.tieBreaker,
  });
}

function optionalQueryString(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > 512) throw new Error("invalid_history_filters");
  return value;
}

function filterKey(filters: Pick<WorkspaceReleaseHistoryFilters, "terminalState" | "projectName" | "from" | "to" | "limit">) {
  return JSON.stringify([filters.terminalState, filters.projectName?.toLocaleLowerCase() || null, filters.from, filters.to, filters.limit]);
}

function encodeCursor(cursor: WorkspaceReleaseHistoryCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): WorkspaceReleaseHistoryCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      parsed?.version !== 2
      || typeof parsed.filterKey !== "string"
      || parsed.filterKey.length > 512
      || !safeTimestamp(parsed.occurredAt)
      || !safeProjectName(parsed.projectName)
      || !TERMINAL_STATES.has(parsed.terminalState)
      || !safeNullableRevision(parsed.candidateReleaseRevision)
      || !safeNullableSha(parsed.sourceCommitShortSha)
      || !safeCode(parsed.lifecycleCode)
      || !isSafeTieBreaker(parsed.tieBreaker)
    ) {
      throw new Error("invalid");
    }
    return parsed;
  } catch {
    throw new Error("invalid_history_filters");
  }
}

function safeProjectName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 160;
}
function safeTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
function safeCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z0-9_]{3,128}$/.test(value);
}
function safeRevision(value: unknown) {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value) ? value : null;
}
function safeSha(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{7,12}$/i.test(value) ? value.toLowerCase() : null;
}

function safeNullableRevision(value: unknown) {
  return value === null || safeRevision(value) !== null;
}

function safeNullableSha(value: unknown) {
  return value === null || safeSha(value) !== null;
}

function isSafeTieBreaker(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{12}$/i.test(value);
}

function enrichHistoryEntry(item: WorkspaceReleaseHistoryItem): WorkspaceReleaseHistoryEntry {
  const existingTieBreaker = (item as WorkspaceReleaseHistoryEntry).tieBreaker;
  return {
    ...item,
    tieBreaker: isSafeTieBreaker(existingTieBreaker) ? existingTieBreaker : safeTieBreakerFromItem(item),
  };
}

function safeTieBreakerFromItem(item: WorkspaceReleaseHistoryItem) {
  return safeTieBreakerHash(JSON.stringify([
    item.projectName,
    item.terminalState,
    item.candidateReleaseRevision,
    item.sourceCommitShortSha,
    item.lifecycleCode,
    item.occurredAt,
  ]));
}

function safeTieBreakerHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function makeTieBreaker(projectId: string) {
  return safeTieBreakerHash(projectId);
}

function toCursor(item: WorkspaceReleaseHistoryEntry, filterKey: string): WorkspaceReleaseHistoryCursor {
  return {
    version: 2,
    filterKey,
    occurredAt: item.occurredAt,
    projectName: item.projectName,
    terminalState: item.terminalState,
    candidateReleaseRevision: item.candidateReleaseRevision,
    sourceCommitShortSha: item.sourceCommitShortSha,
    lifecycleCode: item.lifecycleCode,
    tieBreaker: item.tieBreaker,
  };
}
