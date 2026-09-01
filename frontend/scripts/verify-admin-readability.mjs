import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { classifyAdminFailure, loadIndependentAdminSources } from "../src/utils/adminDataPresentation.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const admin = read("../src/pages/AdminUsers.jsx");
const users = read("../src/components/admin/UserTable.jsx");
const audit = read("../src/components/audit/AuditLogsTable.jsx");
const filters = read("../src/components/audit/AuditLogFilters.jsx");
const styles = read("../src/styles.css");
const service = read("../../backend/src/audit-log/audit-log.service.ts");
const controller = read("../../backend/src/admin/admin.controller.ts");
const projectsController = read("../../backend/src/projects/projects.controller.ts");

for (const tab of ["Overview", "Users & Roles", "Projects & Operations", "Audit Logs"]) assert.match(admin, new RegExp(`label: "${tab}"`));
assert.match(admin, /<Tabs/);
for (const section of ["overview", "users", "projects", "audit"]) assert.match(admin, new RegExp(`data-admin-section="${section}"`));
for (const label of ["GitHub OAuth", "GitHub App", "GitHub Actions", "AWS OIDC", "Terraform State Storage", "Prometheus", "Grafana"]) assert.match(admin, new RegExp(label));
assert.match(admin, /Operation state distribution/);
assert.match(admin, /data-admin-project-state-source="current-state"/);
assert.match(admin, /<DataTable/);
assert.match(admin, /<Pagination/);
assert.match(admin, /loadIndependentAdminSources/);
assert.match(admin, /sourceErrors\.projects/);
assert.match(admin, /Platform data unavailable/);
assert.match(admin, /Project operation evidence unavailable/);
assert.doesNotMatch(admin, /Last updated: \$\{date\(overview\?\.generatedAt\)\}/);
assert.doesNotMatch(admin, /Check the guidance above/);
assert.doesNotMatch(admin, /<dl[\s>]/);
assert.doesNotMatch(admin, /deployGithubActionsDeployment|retryGithubActionsDeployment|destroyGithubActionsDeployment/);
for (const heading of ["User", "GitHub account", "Role", "Access", "Last activity", "Action"]) assert.match(users, new RegExp(`<th>${heading}<`));
assert.match(users, /Disable access/);
assert.match(users, /Re-enable access/);
for (const heading of ["Time", "Actor", "Action", "Resource", "Result", "Source"]) assert.match(audit, new RegExp(`<th>${heading}<`));
assert.match(audit, /<DetailsDrawer/);
assert.match(audit, /Sanitized technical evidence/);
for (const field of ["search", "actorUserId", "action", "projectId", "status", "severity", "from", "to"]) assert.match(filters, new RegExp(`name="${field}"`));
assert.match(service, /query\.projectId/);
assert.match(service, /query\.severity/);
assert.match(service, /query\.search/);
assert.match(service, /getManyAndCount/);
assert.match(controller, /USER_ROLE_UPDATED/);
assert.match(controller, /USER_ENABLED|USER_DISABLED/);
for (const action of ["GITHUB_APP_INSTALLATION_CONNECTED", "GITHUB_ACTIONS_DEPLOYMENT_REQUESTED", "GITHUB_ACTIONS_DEPLOYMENT_RETRIED", "GITHUB_ACTIONS_DESTROY_REQUESTED"]) assert.match(projectsController, new RegExp(action));
assert.doesNotMatch(projectsController, /metadata:\s*\{[^}]*?(?:token|secret|password|authorization)/i);
for (const rule of ["admin-summary-grid", "admin-service-grid", "admin-responsive-table", "audit-details-grid", "admin-audit-filters"]) assert.match(styles, new RegExp(rule));
assert.match(styles, /\.admin-shell::before\{background:linear-gradient\(rgba\(8,12,14,\.92\)/);
assert.match(styles, /\.admin-section\{background:rgba\(18,22,24,\.96\)/);
assert.match(styles, /@media\(max-width:700px\)[\s\S]*admin-responsive-table/);

const ownerError = Object.assign(new Error("Project operations are restricted to the project owner."), { status: 403, code: "FORBIDDEN" });
const ownerFailure = classifyAdminFailure(ownerError, { ownerScoped: true });
assert.equal(ownerFailure.kind, "owner-restriction");
assert.equal(ownerFailure.retryable, false);
assert.equal(ownerFailure.title, "Project operation evidence unavailable");
assert.equal(ownerFailure.message, "Administrative access does not grant ownership of individual project operations.");
assert.equal(ownerFailure.providerMessage, "Project operations are restricted to the project owner.");

const transientFailure = classifyAdminFailure(Object.assign(new Error("Service unavailable"), { status: 503 }));
assert.equal(transientFailure.kind, "transient");
assert.equal(transientFailure.retryable, true);

const partial = await loadIndependentAdminSources({
  users: async () => ({ users: [{ id: "user-1" }] }),
  projects: async () => { throw ownerError; },
  overview: async () => ({ generatedAt: "2026-09-01T12:00:00.000Z" }),
});
assert.equal(partial.users.status, "fulfilled");
assert.equal(partial.projects.status, "rejected");
assert.equal(partial.overview.status, "fulfilled");
assert.deepEqual(partial.users.value.users, [{ id: "user-1" }]);
assert.equal(partial.overview.value.generatedAt, "2026-09-01T12:00:00.000Z");
console.log("Admin and audit presentation verification passed.");
