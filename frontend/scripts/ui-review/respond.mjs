import * as fx from "./fixtures.mjs";

/* Answers one API request from fixtures: [status, json]. */
export function respondFor(url, options = {}) {
  const { pathname, searchParams } = new URL(url);
  const path = pathname.replace(/^\/api/, "");
  const projectMatch = path.match(/^\/projects\/([0-9a-f-]{36})(\/.*)?$/);
  if (path === "/auth/me") return options.auth === false ? [401, { message: "Unauthorized" }] : [200, { user: fx.user }];
  if (path === "/admin-auth/me") return options.admin ? [200, { user: { role: "admin", email: "admin@deployguard.dev" } }] : [401, {}];
  if (path === "/projects/workspace-summary") return [200, options.empty ? { summaries: [], needsAttention: [] } : fx.workspaceSummary()];
  if (path === "/projects/github/status") return [200, { connected: true }];
  if (path === "/projects/github/repositories") return [200, { repositories: [{ id: 1, fullName: "acme/rentmate", defaultBranch: "main" }, { id: 2, fullName: "acme/billing-service", defaultBranch: "main" }] }];
  if (path === "/billing/summary") return [200, fx.billing];
  if (path === "/admin/overview") return [200, fx.admin.overview];
  if (path === "/admin/users") return [200, fx.admin.users];
  if (path === "/admin/projects") return [200, fx.admin.projects];
  if (path.startsWith("/admin/audit-logs")) return [200, fx.admin.audit];
  if (path === "/admin/cloud-cleanup/summary") return [200, fx.cleanup.summary];
  if (path.startsWith("/admin/cloud-cleanup/resources")) return [200, fx.cleanup.resources];
  if (path === "/admin/cloud-cleanup/emergency/preview") return [200, fx.cleanup.emergency];
  if (path === "/admin/cloud-cleanup/emergency/operations") return [200, []];
  if (projectMatch) {
    const [, id, rest = ""] = projectMatch;
    const project = fx.projects[id];
    if (!project) return [404, { message: "Project not found" }];
    if (rest === "") return [200, { project }];
    if (rest === "/current-state") return [200, searchParams.get("detail") ? fx.detailedState(id) : fx.currentStates[id]];
    if (rest.startsWith("/current-state")) return [200, fx.detailedState(id)];
    if (rest === "/deploy/history") return [200, { operations: fx.histories[id] }];
    if (rest === "/activity/view") return [200, {}];
    if (rest === "/database-tier") return [200, { database: id === fx.ids.live ? { provider: "managed", engine: "postgres", persistenceEnabled: true, attachedServiceId: project.services[1].id } : { provider: "none" } }];
    if (/\/services\/[^/]+\/env$/.test(rest) || rest === "/env") return [200, fx.envVars];
    if (rest === "/notifications") return [200, fx.notifications];
    if (rest.startsWith("/observability/application-metrics")) return [200, fx.metrics];
    if (rest === "/troubleshooting") return [200, id === fx.ids.failed && options.withSession ? { ...fx.troubleshootingList, items: [fx.troubleshootingSession.session] } : fx.troubleshootingList];
    if (rest.startsWith("/troubleshooting/")) return [200, fx.troubleshootingSession];
    if (rest === "/deploy/rollback-candidates") return [200, { candidates: [{ targetOperationId: "op-live-13", releaseRevision: "13", commitSha: fx.histories[id]?.[1]?.commitSha, services: project.services, appPort: 3000, healthCheckPath: "/health" }] }];
  }
  return [200, {}];
}

