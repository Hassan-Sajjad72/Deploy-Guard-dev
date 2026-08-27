import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getAdminAuditLogs, getAdminOverview, getAdminProjects, getUsers, updateUserAccess, updateUserRole } from "../api/adminApi.js";
import AuditLogFilters from "../components/audit/AuditLogFilters.jsx";
import AuditLogsTable from "../components/audit/AuditLogsTable.jsx";
import UserTable from "../components/admin/UserTable.jsx";
import { Banner, Card, ChartCard, DataTable, EmptyState, MetricCard, PageHeader, StatusChip, Tabs } from "../components/common/DesignSystem.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import Pagination from "../components/common/Pagination.jsx";
import { projectStatePresentation } from "../utils/projectStatePresentation.js";

const tabs = [
  { id: "overview", label: "Overview", icon: "dashboard" },
  { id: "users", label: "Users & Roles", icon: "user" },
  { id: "projects", label: "Projects & Operations", icon: "infrastructure" },
  { id: "audit", label: "Audit Logs", icon: "logs" },
];
const defaultAuditFilters = { search: "", actorUserId: "", action: "", projectId: "", status: "", severity: "", from: "", to: "", page: 1, limit: 20 };
const serviceLabels = { backend: "Backend", database: "PostgreSQL", githubOAuth: "GitHub OAuth", githubApp: "GitHub App", githubActions: "GitHub Actions", awsOidc: "AWS OIDC", terraformState: "Terraform State Storage", prometheus: "Prometheus", grafana: "Grafana" };

function label(value) {
  return value ? String(value).replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Unavailable";
}

function date(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Unavailable";
}

function short(value) {
  if (!value) return "No deployment operation";
  const text = String(value);
  return text.length > 18 ? `${text.slice(0, 9)}…${text.slice(-7)}` : text;
}

function serviceSource(value) {
  if (value === "live_api") return "Live API";
  if (value === "postgresql_probe") return "PostgreSQL probe";
  if (value === "runtime_configuration") return "Runtime configuration";
  return label(value);
}

function AdminOperationChart({ counts }) {
  const active = Number(counts?.activeOperations || 0);
  const failed = Number(counts?.failedOperations || 0);
  const total = active + failed;
  if (!total) return null;
  return <ChartCard description="Counts are calculated from persisted GitHub Actions operation records." hasData title="Operation state distribution">
    <ol aria-label="Operation state distribution" className="admin-operation-chart">
      <li><span>Active</span><strong>{active}</strong><i style={{ width: `${Math.round((active / total) * 100)}%` }} /></li>
      <li><span>Failed</span><strong>{failed}</strong><i className="is-failed" style={{ width: `${Math.round((failed / total) * 100)}%` }} /></li>
    </ol>
  </ChartCard>;
}

export default function AdminUsers() {
  const [activeTab, setActiveTab] = useState("overview");
  const [users, setUsers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [overview, setOverview] = useState(null);
  const [logs, setLogs] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0, totalPages: 1 });
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(true);
  const [auditLoading, setAuditLoading] = useState(false);
  const [updatingUserId, setUpdatingUserId] = useState(null);
  const [projectFilter, setProjectFilter] = useState("ALL");
  const [auditFilters, setAuditFilters] = useState(defaultAuditFilters);

  const loadAudit = useCallback(async () => {
    setAuditLoading(true);
    try {
      const response = await getAdminAuditLogs(auditFilters);
      setLogs(response?.logs || []);
      setPagination(response?.pagination || { page: auditFilters.page, limit: auditFilters.limit, total: 0, totalPages: 1 });
    } catch (caught) { setError(caught.message); } finally { setAuditLoading(false); }
  }, [auditFilters]);

  const load = useCallback(async () => {
    setError(""); setLoading(true);
    try {
      const [userResponse, workspace, platform] = await Promise.all([getUsers(), getAdminProjects(), getAdminOverview()]);
      setUsers(userResponse?.users || []);
      setProjects(workspace?.summaries || []);
      setOverview(platform);
    } catch (caught) { setError(caught.message); } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (activeTab === "audit") void loadAudit(); }, [activeTab, loadAudit]);

  async function mutate(userId, request, message) {
    setError(""); setSuccess(""); setUpdatingUserId(userId);
    try {
      const response = await request();
      setUsers((current) => current.map((user) => user.id === userId ? { ...user, ...response.user } : user));
      setSuccess(message);
      if (activeTab === "audit") await loadAudit();
    } catch (caught) { setError(caught.message); } finally { setUpdatingUserId(null); }
  }

  const ownerById = useMemo(() => new Map(users.map((user) => [String(user.id), user])), [users]);
  const filteredProjects = projects.filter(({ currentState }) => projectFilter === "ALL" || projectStatePresentation(currentState).state === projectFilter);
  const generated = date(overview?.generatedAt);
  return <div className="admin-console grid" data-admin-console="canonical">
    <PageHeader context={`Source: live API · Last updated: ${generated}`} description="Platform status, user access, project operation evidence, and sanitized audit records." eyebrow="Platform administration" title="Admin" />
    {error ? <ErrorState message={error} onRetry={activeTab === "audit" ? loadAudit : load} /> : null}
    {success ? <Banner title="Access updated" tone="success">{success}</Banner> : null}
    {loading ? <LoadingState message="Loading administration console…" /> : null}
    {!loading && overview ? <>
      <Tabs activeId={activeTab} idPrefix="admin" items={tabs} label="Admin sections" onChange={setActiveTab} />
      {activeTab === "overview" ? <section aria-labelledby="admin-tab-overview" className="admin-section" data-admin-section="overview" id="admin-panel-overview" role="tabpanel"><div className="admin-section-heading"><div><p className="eyebrow">Platform status</p><h2>Service readiness</h2><p>Each status comes from the live platform overview endpoint. Disabled providers remain explicit.</p></div></div>
        <section className="admin-summary-grid"><MetricCard detail="Non-archived projects in PostgreSQL" label="Projects" value={overview.counts.projects} /><MetricCard detail={`${overview.counts.destroyingOperations} currently destroying`} label="Active operations" value={overview.counts.activeOperations} /><MetricCard detail="Persisted GitHub Actions operation records" label="Failed operations" tone={overview.counts.failedOperations ? "danger" : "neutral"} value={overview.counts.failedOperations} /></section>
        <section aria-label="Platform service status" className="admin-service-grid">{Object.entries(overview.services).map(([name, service]) => <Card className="admin-service-card" key={name}><span>{serviceLabels[name] || label(name)}</span><StatusChip status={service.status}>{label(service.status)}</StatusChip><small>Source: {serviceSource(service.source)}</small></Card>)}</section>
        <AdminOperationChart counts={overview.counts} />
      </section> : null}
      {activeTab === "users" ? <section aria-labelledby="admin-tab-users" className="admin-section" data-admin-section="users" id="admin-panel-users" role="tabpanel"><div className="admin-section-heading"><div><p className="eyebrow">Users &amp; roles</p><h2>Account access</h2><p>GitHub-authenticated accounts only. Role and access changes are retained in the audit trail.</p></div></div>{users.length ? <UserTable onAccessChange={(id, enabled) => mutate(id, () => updateUserAccess(id, enabled), enabled ? "User access enabled." : "User access disabled.")} onRoleChange={(id, role) => mutate(id, () => updateUserRole(id, role), "User role updated.")} updatingUserId={updatingUserId} users={users} /> : <EmptyState message="No users found." title="No user records" />}</section> : null}
      {activeTab === "projects" ? <section aria-labelledby="admin-tab-projects" className="admin-section" data-admin-project-state-source="current-state" data-admin-section="projects" id="admin-panel-projects" role="tabpanel"><div className="admin-section-heading"><div><p className="eyebrow">Projects &amp; operations</p><h2>Authoritative project states</h2><p>Read-only operational evidence. Project lifecycle actions remain on each owner's Overview and Pipeline.</p></div></div>
        <div aria-label="Project state filter" className="admin-project-filters">{["ALL", "LIVE", "DEPLOYING", "FAILED", "DESTROYED"].map((filter) => <button aria-pressed={projectFilter === filter} className={projectFilter === filter ? "button" : "secondary-button"} key={filter} onClick={() => setProjectFilter(filter)} type="button">{filter === "ALL" ? "All" : label(filter)}</button>)}</div>
        {filteredProjects.length ? <DataTable caption="Canonical project states and their latest recorded operation" className="admin-responsive-table admin-project-table" label="Projects and operations table"><thead><tr><th>Owner</th><th>Repository</th><th>State</th><th>Latest operation</th><th>Updated</th></tr></thead><tbody>{filteredProjects.map(({ project, currentState }) => { const state = projectStatePresentation(currentState); const owner = ownerById.get(String(project.ownerUserId)); const operation = currentState?.latestAttempt?.operationId || currentState?.stateAuthority?.latestCompletedOperation?.id; const updated = currentState?.stateAuthority?.reconciliation?.lastReconciledAt || currentState?.latestAttempt?.occurredAt; return <tr data-authoritative-state={state.state} key={project.id}><td data-label="Owner"><strong>{owner?.name || `Account #${project.ownerUserId}`}</strong><span className="admin-cell-detail">{owner?.githubLogin ? `@${owner.githubLogin}` : owner?.email || "Account record"}</span></td><td data-label="Repository"><Link title={project.repositoryFullName || "Repository unavailable"} to={`/projects/${project.id}`}>{project.repositoryFullName || "Repository unavailable"}</Link><span className="admin-cell-detail">{project.targetBranch || "Branch unavailable"}</span></td><td data-label="State"><StatusChip status={state.state}>{label(state.state)}</StatusChip></td><td data-label="Latest operation" title={operation || "No deployment operation"}>{short(operation)}</td><td data-label="Updated">{date(updated)}</td></tr>; })}</tbody></DataTable> : <EmptyState message="No projects match this state filter." title="No matching projects" />}
      </section> : null}
      {activeTab === "audit" ? <section aria-labelledby="admin-tab-audit" className="admin-section" data-admin-section="audit" id="admin-panel-audit" role="tabpanel"><div className="admin-section-heading"><div><p className="eyebrow">Audit logs</p><h2>Sanitized administrative and product activity</h2><p>Search persisted records by actor, action, project, result, severity, or date. Selecting a record opens sanitized details.</p></div></div>
        <AuditLogFilters filters={auditFilters} onChange={setAuditFilters} onReset={() => setAuditFilters(defaultAuditFilters)} />
        {auditLoading ? <LoadingState message="Loading audit logs…" /> : logs.length ? <><AuditLogsTable logs={logs} /><Pagination onLimitChange={(limit) => setAuditFilters((current) => ({ ...current, limit, page: 1 }))} onPageChange={(page) => setAuditFilters((current) => ({ ...current, page }))} pagination={pagination} /></> : <EmptyState message="No audit events match these filters." title="No matching audit records" />}
      </section> : null}
    </> : null}
  </div>;
}
