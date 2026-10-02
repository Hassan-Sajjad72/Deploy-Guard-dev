import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { classifyAdminFailure, loadIndependentAdminSources } from "../src/utils/adminDataPresentation.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const admin = read("../src/pages/AdminUsers.jsx");
const adminLayout = read("../src/components/layout/AdminLayout.jsx");
const users = read("../src/components/admin/UserTable.jsx");
const audit = read("../src/components/audit/AuditLogsTable.jsx");
const filters = read("../src/components/audit/AuditLogFilters.jsx");
const auditDetails = read("../src/components/audit/AuditLogDetails.jsx");
const styles = read("../src/styles/pages/admin.css") + read("../src/styles/components.css");
const service = read("../../backend/src/audit-log/audit-log.service.ts");
const controller = read("../../backend/src/admin/admin.controller.ts");
const projectsController = read("../../backend/src/projects/projects.controller.ts");

for (const tab of ["Overview", "Users", "Projects", "Audit log", "Cloud cleanup"]) assert.match(adminLayout, new RegExp(`label: "${tab}"`));
assert.match(adminLayout, /className=\{section === tab\.section \? "header-tab is-active" : "header-tab"\}/, "admin sections are header tabs, like the product");
assert.match(adminLayout, /to: "\/admin\/cleanup", section: "cleanup"/);
assert.match(adminLayout, /aria-current=\{section === tab\.section \? "page" : undefined\}/);
assert.doesNotMatch(admin, /<Tabs/, "one navigation surface: the header tabs");
for (const section of ["overview", "users", "projects", "audit"]) assert.match(admin, new RegExp(`data-admin-section="${section}"`));
for (const label of ["GitHub sign-in", "GitHub App", "GitHub Actions", "AWS access \\(OIDC\\)", "Terraform state storage", "Prometheus", "Grafana"]) assert.match(admin, new RegExp(label));
assert.match(admin, /Needs attention/, "the overview leads with what needs an administrator");
assert.match(admin, /Disabled integrations are shown, not hidden/);
assert.match(admin, /serviceTone\(service\.status\)/);
assert.match(admin, /data-service-tone=\{serviceTone\(service\.status\)\}/);
assert.match(admin, /Role updated\./);
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
for (const heading of ["User", "GitHub", "Role", "Access", "Last sign-in"]) assert.match(users, new RegExp(`<th>${heading}<`));
assert.match(users, /Disable access/);
assert.match(users, /Re-enable access/);
assert.match(users, /tone=\{user\.enabled \? "success" : "danger"\}/);
for (const heading of ["Time", "Actor", "Action", "Resource", "Result"]) assert.match(audit, new RegExp(`<th>${heading}<`));
assert.match(audit, /<DetailsDrawer/);
assert.match(audit, /Sensitive values are redacted/);
for (const field of ["search", "action", "status", "severity", "from", "to"]) assert.match(filters, new RegExp(`name="${field}"`));
assert.doesNotMatch(filters, /actorUserId|projectId/);
assert.match(auditDetails, /HIDDEN_IDENTIFIER_KEYS/);
assert.match(auditDetails, /actoruserid.*projectid/);
assert.match(service, /query\.projectId/);
assert.match(service, /query\.severity/);
assert.match(service, /query\.search/);
assert.match(service, /getManyAndCount/);
assert.match(controller, /USER_ROLE_UPDATED/);
assert.match(controller, /USER_ENABLED|USER_DISABLED/);
for (const action of ["GITHUB_APP_INSTALLATION_CONNECTED", "GITHUB_ACTIONS_DEPLOYMENT_REQUESTED", "GITHUB_ACTIONS_DEPLOYMENT_RETRIED", "GITHUB_ACTIONS_DESTROY_REQUESTED"]) assert.match(projectsController, new RegExp(action));
assert.doesNotMatch(projectsController, /metadata:\s*\{[^}]*?(?:token|secret|password|authorization)/i);
for (const rule of ["admin-stats", "admin-attention", "audit-filters", "table-stack"]) assert.match(styles, new RegExp(rule));
assert.match(styles, /@media \(max-width: 720px\)[\s\S]*\.table-stack/, "admin tables stack into labelled rows on phones");
assert.match(users, /<DataTable/);
assert.match(audit, /data-label="Result"/);

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
