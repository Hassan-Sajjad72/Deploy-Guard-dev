import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { getAdminAuditLogs, getAdminOverview, getAdminProjects, getUsers, updateUserAccess, updateUserRole } from "../api/adminApi.js";
import AuditLogFilters from "../components/audit/AuditLogFilters.jsx";
import AuditLogsTable from "../components/audit/AuditLogsTable.jsx";
import UserTable from "../components/admin/UserTable.jsx";
import AppIcon from "../components/common/AppIcon.jsx";
import { Banner, Button, Callout, DataTable, EmptyState, PageHeader, Status } from "../components/common/DesignSystem.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import Pagination from "../components/common/Pagination.jsx";
import Time from "../components/common/Time.jsx";
import { classifyAdminFailure, loadIndependentAdminSources } from "../utils/adminDataPresentation.js";
import { projectStateLabel, projectStatePresentation, projectStateTone } from "../utils/projectStatePresentation.js";

const sections = ["overview", "users", "projects", "audit"];
const defaultAuditFilters = { search: "", action: "", status: "", severity: "", from: "", to: "", page: 1, limit: 20 };
const serviceLabels = { backend: "API", database: "PostgreSQL", githubOAuth: "GitHub sign-in", githubApp: "GitHub App", githubActions: "GitHub Actions", awsOidc: "AWS access (OIDC)", terraformState: "Terraform state storage", prometheus: "Prometheus", grafana: "Grafana" };

function label(value) {
  return value ? String(value).replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replaceAll("-", " ").toLowerCase().replace(/^\w/, (letter) => letter.toUpperCase()) : "—";
}

function serviceSource(value) {
  if (value === "live_api") return "Live check";
  if (value === "postgresql_probe") return "Database probe";
  if (value === "runtime_configuration") return "Configuration";
  return label(value);
}

function serviceTone(status) {
  if (["available", "configured"].includes(status)) return "success";
  if (status === "degraded") return "warning";
  if (status === "disabled") return "neutral";
  return "danger";
}

function AdminSectionFailure({ failure, onRetry, title }) {
  if (!failure) return null;
  const metadata = [failure.code ? `Code: ${failure.code}` : null, failure.status ? `HTTP ${failure.status}` : null].filter(Boolean).join(" · ");
  const providerDetail = failure.providerMessage !== failure.message ? failure.providerMessage : null;
  return <Banner actions={failure.retryable && onRetry ? <Button onClick={onRetry} size="sm">Try again</Button> : null} title={failure.title || title} tone={failure.kind === "owner-restriction" ? "warning" : "danger"}>
    <p>{failure.message}</p>
    {providerDetail ? <p className="admin-error-metadata">Provider detail: {providerDetail}</p> : null}
    {metadata ? <p className="admin-error-metadata mono">{metadata}</p> : null}
  </Banner>;
}

const PAGE_COPY = {
  overview: ["Platform overview", "What needs administrator attention across DeployGuard."],
  users: ["Users", "Who can sign in, and what they can do. Changes are recorded in the audit log."],
  projects: ["Projects", "Every project's current state. Deployment actions stay with each project's owner."],
  audit: ["Audit log", "Who did what, and whether it succeeded. Sensitive values are redacted."],
};

export default function AdminUsers() {
  const [searchParams] = useSearchParams();
  const activeTab = sections.includes(searchParams.get("section")) ? searchParams.get("section") : "overview";
  const [users, setUsers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [overview, setOverview] = useState(null);
  const [logs, setLogs] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0, totalPages: 1 });
  const [sourceErrors, setSourceErrors] = useState({ audit: null, overview: null, projects: null, users: null });
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(true);
  const [auditLoading, setAuditLoading] = useState(false);
  const [updatingUserId, setUpdatingUserId] = useState(null);
  const [projectFilter, setProjectFilter] = useState("ALL");
  const [auditFilters, setAuditFilters] = useState(defaultAuditFilters);

  const loadAudit = useCallback(async () => {
    setSourceErrors((current) => ({ ...current, audit: null }));
    setAuditLoading(true);
    try {
      const response = await getAdminAuditLogs(auditFilters);
      setLogs(response?.logs || []);
      setPagination(response?.pagination || { page: auditFilters.page, limit: auditFilters.limit, total: 0, totalPages: 1 });
    } catch (caught) { setSourceErrors((current) => ({ ...current, audit: classifyAdminFailure(caught) })); } finally { setAuditLoading(false); }
  }, [auditFilters]);

  const load = useCallback(async () => {
    setSourceErrors((current) => ({ ...current, overview: null, projects: null, users: null }));
    setLoading(true);
    const results = await loadIndependentAdminSources({
      users: () => getUsers(),
      projects: () => getAdminProjects(),
      overview: () => getAdminOverview(),
    });
    if (results.users.status === "fulfilled") setUsers(results.users.value?.users || []);
    if (results.projects.status === "fulfilled") setProjects(results.projects.value?.summaries || []);
    if (results.overview.status === "fulfilled") setOverview(results.overview.value);
    setSourceErrors((current) => ({
      ...current,
      users: results.users.status === "rejected" ? classifyAdminFailure(results.users.reason) : null,
      projects: results.projects.status === "rejected" ? classifyAdminFailure(results.projects.reason, { ownerScoped: true }) : null,
      overview: results.overview.status === "rejected" ? classifyAdminFailure(results.overview.reason) : null,
    }));
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (activeTab === "audit") void loadAudit(); }, [activeTab, loadAudit]);
  useEffect(() => { setSuccess(""); }, [activeTab]);

  async function mutate(userId, request, message) {
    setSourceErrors((current) => ({ ...current, users: null })); setSuccess(""); setUpdatingUserId(userId);
    try {
      const response = await request();
      setUsers((current) => current.map((user) => user.id === userId ? { ...user, ...response.user } : user));
      setSuccess(message);
      if (activeTab === "audit") await loadAudit();
    } catch (caught) { setSourceErrors((current) => ({ ...current, users: classifyAdminFailure(caught) })); } finally { setUpdatingUserId(null); }
  }

  const ownerById = useMemo(() => new Map(users.map((user) => [String(user.id), user])), [users]);
  const filteredProjects = projects.filter(({ currentState }) => projectFilter === "ALL" || projectStatePresentation(currentState).state === projectFilter);
  const projectCounts = useMemo(() => projects.reduce((totals, { currentState }) => { const state = projectStatePresentation(currentState).state; return { ...totals, [state]: (totals[state] || 0) + 1 }; }, { ALL: projects.length }), [projects]);
  const [pageTitle, pageDescription] = PAGE_COPY[activeTab];
  const attention = overview ? [
    ...(overview.counts.failedOperations ? [{ key: "failed", tone: "danger", text: `${overview.counts.failedOperations} failed operation${overview.counts.failedOperations === 1 ? "" : "s"} on record`, to: "/admin?section=projects", action: "Review projects" }] : []),
    ...Object.entries(overview.services).filter(([, service]) => !["available", "configured", "disabled"].includes(service.status)).map(([name, service]) => ({ key: name, tone: serviceTone(service.status), text: `${serviceLabels[name] || label(name)} is ${label(service.status).toLowerCase()}` })),
  ] : [];

  return <div className="page admin-page" data-admin-console="canonical">
    <PageHeader description={<>{pageDescription}{activeTab === "overview" && overview?.generatedAt ? <> Updated <Time value={overview.generatedAt} />.</> : null}</>} title={pageTitle} />
    {activeTab === "users" && success ? <Callout tone="success">{success}</Callout> : null}
    {loading ? <LoadingState inline message="Loading the admin console…" /> : null}

    {!loading && activeTab === "overview" ? <section className="admin-section" data-admin-section="overview" id="admin-panel-overview">
      {sourceErrors.overview ? <AdminSectionFailure failure={sourceErrors.overview} onRetry={load} title="Platform status unavailable" /> : overview ? <>
        <p className="admin-totals"><strong className="num">{overview.counts.projects}</strong> projects · <strong className="num">{overview.counts.activeOperations}</strong> operation{overview.counts.activeOperations === 1 ? "" : "s"} running{overview.counts.destroyingOperations ? ` (${overview.counts.destroyingOperations} destroying)` : ""}</p>
        <section aria-labelledby="admin-attention" className="section">
          <div className="section-head"><h2 id="admin-attention">Needs attention</h2></div>
          {attention.length ? <ul className="rows admin-attention">{attention.map((item) => <li key={item.key}><Status tone={item.tone}>{item.text}</Status>{item.to ? <Link className="link" to={item.to}>{item.action}</Link> : null}</li>)}</ul> : <p className="muted admin-calm"><AppIcon name="check-circle" size={16} />Nothing needs attention right now.</p>}
        </section>
        <section aria-labelledby="admin-services" className="section">
          <div className="section-head"><h2 id="admin-services">Platform services</h2><p>Each status comes from a live check or configuration. Disabled integrations are shown, not hidden.</p></div>
          <DataTable caption="Platform service status" label="Platform service status"><thead><tr><th>Service</th><th>Status</th><th>Checked by</th></tr></thead><tbody>{Object.entries(overview.services).map(([name, service]) => <tr data-service-tone={serviceTone(service.status)} key={name}><td data-label="Service">{serviceLabels[name] || label(name)}</td><td data-label="Status"><Status tone={serviceTone(service.status)}>{label(service.status)}</Status></td><td data-label="Checked by" className="muted">{serviceSource(service.source)}</td></tr>)}</tbody></DataTable>
        </section>
      </> : <EmptyState compact message="The platform overview endpoint returned nothing." title="Platform data unavailable" />}
    </section> : null}

    {!loading && activeTab === "users" ? <section className="admin-section" data-admin-section="users" id="admin-panel-users">
      {sourceErrors.users ? <AdminSectionFailure failure={sourceErrors.users} onRetry={load} title="User access information unavailable" /> : users.length ? <UserTable onAccessChange={(id, enabled) => mutate(id, () => updateUserAccess(id, enabled), enabled ? "Access re-enabled." : "Access disabled.")} onRoleChange={(id, role) => mutate(id, () => updateUserRole(id, role), "Role updated.")} updatingUserId={updatingUserId} users={users} /> : <EmptyState compact message="Users appear here after they sign in with GitHub." title="No users yet" />}
    </section> : null}

    {!loading && activeTab === "projects" ? <section className="admin-section" data-admin-project-state-source="current-state" data-admin-section="projects" id="admin-panel-projects">
      {sourceErrors.projects ? <AdminSectionFailure failure={sourceErrors.projects} onRetry={load} title="Project operation evidence unavailable" /> : <>
        <div aria-label="Project state filter" className="segmented" role="group">{["ALL", "LIVE", "DEPLOYING", "FAILED", "DESTROYED"].map((filter) => <button aria-pressed={projectFilter === filter} key={filter} onClick={() => setProjectFilter(filter)} type="button">{filter === "ALL" ? "All" : projectStateLabel(filter)}<span className="count">{projectCounts[filter] || 0}</span></button>)}</div>
        {filteredProjects.length ? <DataTable caption="Projects and their latest recorded operation" label="Projects and operations"><thead><tr><th>Project</th><th>Owner</th><th>State</th><th>Latest operation</th><th>Updated</th></tr></thead><tbody>{filteredProjects.map(({ project, currentState }) => {
          const state = projectStatePresentation(currentState);
          const owner = ownerById.get(String(project.ownerUserId));
          const latest = currentState?.latestAttempt || currentState?.stateAuthority?.latestCompletedOperation;
          const operation = latest?.operationId || latest?.id;
          const operationType = latest?.operationType || latest?.type || latest?.deploymentAction || latest?.metadata?.deploymentAction;
          const updated = currentState?.stateAuthority?.reconciliation?.lastReconciledAt || currentState?.latestAttempt?.occurredAt;
          return <tr data-authoritative-state={state.state} key={project.id}>
            <td data-label="Project"><Link className="admin-project-link" to={`/projects/${project.id}`}>{project.name || project.repositoryFullName}</Link><span className="cell-sub">{project.repositoryFullName || "Repository unavailable"} · {project.targetBranch || "—"}</span></td>
            <td data-label="Owner">{owner?.name || `Account #${project.ownerUserId}`}<span className="cell-sub">{owner?.githubLogin ? `@${owner.githubLogin}` : owner?.email || ""}</span></td>
            <td data-label="State"><Status active={state.active} tone={state.state === "FAILED" ? "danger" : projectStateTone(state.state)}>{projectStateLabel(state.state)}</Status></td>
            <td data-label="Latest operation">{operationType ? label(operationType) : "None"}{operation ? <span className="cell-sub mono" title={operation}>{String(operation).slice(0, 12)}</span> : null}</td>
            <td data-label="Updated">{updated ? <Time value={updated} /> : "—"}</td>
          </tr>;
        })}</tbody></DataTable> : <EmptyState compact message="No projects are in this state." title="No matching projects" />}
      </>}
    </section> : null}

    {!loading && activeTab === "audit" ? <section className="admin-section" data-admin-section="audit" id="admin-panel-audit">
      {sourceErrors.audit ? <AdminSectionFailure failure={sourceErrors.audit} onRetry={loadAudit} title="Audit activity unavailable" /> : <>
        <AuditLogFilters filters={auditFilters} onChange={setAuditFilters} onReset={() => setAuditFilters(defaultAuditFilters)} />
        {auditLoading ? <LoadingState inline message="Loading audit records…" /> : logs.length ? <><AuditLogsTable logs={logs} /><Pagination onLimitChange={(limit) => setAuditFilters((current) => ({ ...current, limit, page: 1 }))} onPageChange={(page) => setAuditFilters((current) => ({ ...current, page }))} pagination={pagination} /></> : <EmptyState compact message="Try widening the date range or clearing filters." title="No matching audit records" />}
      </>}
    </section> : null}
  </div>;
}
