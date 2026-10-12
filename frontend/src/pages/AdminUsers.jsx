import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams, useOutletContext } from "react-router-dom";
import { getAdminAuditLogs, getAdminOverview, getAdminProjects, getAdminOrganizations, getUsers, updateUserRole, verifyAdminIdentity } from "../api/adminApi.js";
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
import { adminSectionAllowed } from "../utils/adminScope.js";

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
  projects: ["Projects", "Recorded project and operation status. Runtime evidence requires a customer-approved support grant."],
  audit: ["Audit log", "Who did what, and whether it succeeded. Sensitive values are redacted."],
};

export default function AdminUsers() {
  const { adminUser } = useOutletContext();
  const [searchParams] = useSearchParams();
  const activeTab = sections.includes(searchParams.get("section")) ? searchParams.get("section") : "overview";
  const [users, setUsers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [organizations, setOrganizations] = useState([]);
  const [overview, setOverview] = useState(null);
  const [logs, setLogs] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, total: 0, totalPages: 1 });
  const [sourceErrors, setSourceErrors] = useState({ audit: null, overview: null, projects: null, users: null });
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(true);
  const [auditLoading, setAuditLoading] = useState(false);
  const [updatingUserId, setUpdatingUserId] = useState(null);
  const [projectFilter, setProjectFilter] = useState("ALL");
  const [recordSearch,setRecordSearch]=useState(""),[organizationFilter,setOrganizationFilter]=useState("");
  const [auditFilters, setAuditFilters] = useState(defaultAuditFilters);
  const [changeReason, setChangeReason] = useState("");
  const [verifiedUntil, setVerifiedUntil] = useState(null);
  const [verificationError, setVerificationError] = useState("");

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
      users: () => adminSectionAllowed(adminUser?.internalAdminRole, "users") ? getUsers() : Promise.resolve({ users: [] }),
      projects: () => adminSectionAllowed(adminUser?.internalAdminRole, "projects") ? getAdminProjects() : Promise.resolve({ summaries: [] }),
      overview: () => adminSectionAllowed(adminUser?.internalAdminRole, "overview") ? getAdminOverview() : Promise.resolve(null),
      organizations: () => adminSectionAllowed(adminUser?.internalAdminRole, "overview") ? getAdminOrganizations() : Promise.resolve({ organizations: [] }),
    });
    if (results.users.status === "fulfilled") setUsers(results.users.value?.users || []);
    if (results.projects.status === "fulfilled") setProjects(results.projects.value?.summaries || []);
    if (results.overview.status === "fulfilled") setOverview(results.overview.value);
    if (results.organizations.status === "fulfilled") setOrganizations(results.organizations.value?.organizations || []);
    setSourceErrors((current) => ({
      ...current,
      users: results.users.status === "rejected" ? classifyAdminFailure(results.users.reason) : null,
      projects: results.projects.status === "rejected" ? classifyAdminFailure(results.projects.reason, { ownerScoped: true }) : null,
      overview: results.overview.status === "rejected" ? classifyAdminFailure(results.overview.reason) : null,
      organizations: results.organizations.status === "rejected" ? classifyAdminFailure(results.organizations.reason) : null,
    }));
    setLoading(false);
  }, [adminUser?.internalAdminRole]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (activeTab === "audit") void loadAudit(); }, [activeTab, loadAudit]);
  useEffect(() => { setSuccess("");setRecordSearch("");setOrganizationFilter(""); }, [activeTab]);
  useEffect(() => {
    if (!success) return undefined;
    const timer = window.setTimeout(() => setSuccess(""), 4200);
    return () => window.clearTimeout(timer);
  }, [success]);

  async function mutate(userId, request, message) {
    setSourceErrors((current) => ({ ...current, users: null })); setSuccess(""); setUpdatingUserId(userId);
    try {
      const response = await request();
      setUsers((current) => current.map((user) => user.id === userId ? { ...user, ...response.user } : user));
      setSuccess(message);
      if (activeTab === "audit") await loadAudit();
    } catch (caught) { setSourceErrors((current) => ({ ...current, users: classifyAdminFailure(caught) })); } finally { setUpdatingUserId(null); }
  }

  const organizationById=useMemo(()=>new Map(organizations.map((organization)=>[organization.id,organization])),[organizations]);
  const matchesSearch=(values)=>values.filter((value)=>value!==null&&value!==undefined).join(" ").toLowerCase().includes(recordSearch.trim().toLowerCase());
  const visibleUsers=users.filter((user)=>matchesSearch([user.id,user.name,user.email,user.githubLogin,user.role,user.internalAdminRole,user.enabled?"enabled":"suspended"]));
  const visibleOrganizations=organizations.filter((organization)=>matchesSearch([organization.id,organization.name,organization.kind,organization.archivedAt?"archived":"active"]));
  const filteredProjects = projects.filter(({ project, currentState }) => (!organizationFilter||project.organizationId===organizationFilter)&&matchesSearch([project.id,project.name,project.organizationId,organizationById.get(project.organizationId)?.name,project.status,project.operationStatus])&&(projectFilter === "ALL" || (currentState ? projectStatePresentation(currentState).state === projectFilter : projectFilter === "FAILED" && project.operationStatus === "failed")));
  const projectCounts = useMemo(() => projects.reduce((totals, { project, currentState }) => { const state = currentState ? projectStatePresentation(currentState).state : project.operationStatus === "failed" ? "FAILED" : "UNVERIFIED"; return { ...totals, [state]: (totals[state] || 0) + 1 }; }, { ALL: projects.length }), [projects]);
  const [pageTitle, pageDescription] = PAGE_COPY[activeTab];
  const attention = overview ? [
    ...(overview.counts.failedOperations ? [{ key: "failed", tone: "danger", text: `${overview.counts.failedOperations} failed operation${overview.counts.failedOperations === 1 ? "" : "s"} on record`, to: "/admin?section=projects", action: "Review projects" }] : []),
    ...Object.entries(overview.services).filter(([, service]) => !["available", "configured", "disabled"].includes(service.status)).map(([name, service]) => ({ key: name, tone: serviceTone(service.status), text: `${serviceLabels[name] || label(name)} is ${label(service.status).toLowerCase()}` })),
  ] : [];

  return <div className="page admin-page" data-admin-console="canonical">
    <PageHeader description={<>{pageDescription}{activeTab === "overview" && overview?.generatedAt ? <> Updated <Time value={overview.generatedAt} />.</> : null}</>} title={pageTitle} />
    <p><Link to="/admin/access">Manage privileged roles, identity confirmation and authorized support access</Link></p>
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
      <section className="section"><h2>Organizations</h2><label className="field"><span>Search authorized organizations</span><input type="search" value={recordSearch} onChange={(event)=>setRecordSearch(event.target.value)}/></label>{sourceErrors.organizations ? <AdminSectionFailure failure={sourceErrors.organizations} onRetry={load} title="Organization status unavailable" /> : visibleOrganizations.length ? <DataTable caption="Organization status and recorded usage" label="Organization status"><thead><tr><th>Organization</th><th>Kind</th><th>Status</th><th>Members</th><th>Projects</th></tr></thead><tbody>{visibleOrganizations.map((organization) => <tr key={organization.id}><td data-label="Organization">{organization.name}<span className="cell-sub mono">{organization.id}</span></td><td data-label="Kind">{label(organization.kind)}</td><td data-label="Status">{organization.archivedAt ? "Archived" : "Active"}</td><td data-label="Members">{organization.members}</td><td data-label="Projects">{organization.projects}</td></tr>)}</tbody></DataTable> : <p>{organizations.length?"No organizations match this search.":"No organizations recorded."}</p>}</section>
    </section> : null}

    {!loading && activeTab === "users" ? <section className="admin-section" data-admin-section="users" id="admin-panel-users">
      <form className="panel" onSubmit={async (event) => { event.preventDefault(); const form = event.currentTarget; const password = new FormData(form).get("password"); setVerificationError(""); try { const response = await verifyAdminIdentity(password); setVerifiedUntil(response.expiresAt); form.reset(); } catch (caught) { setVerificationError(caught.message); } }}><label className="field"><span>Confirm administrator password</span><input name="password" type="password" required autoComplete="current-password" maxLength={200} /></label><Button type="submit">Verify identity for sensitive actions</Button>{verifiedUntil ? <p role="status">Identity verified until {new Date(verifiedUntil).toLocaleTimeString()}.</p> : null}{verificationError ? <p role="alert">{verificationError}</p> : null}</form>
      <label className="field"><span>Reason for account role change</span><input value={changeReason} onChange={(event) => setChangeReason(event.target.value)} required maxLength={1000} /></label>
      <label className="field"><span>Search authorized users</span><input type="search" value={recordSearch} onChange={(event)=>setRecordSearch(event.target.value)}/></label>
      {sourceErrors.users ? <AdminSectionFailure failure={sourceErrors.users} onRetry={load} title="User access information unavailable" /> : visibleUsers.length ? <UserTable onRoleChange={(id, role) => { if (!verifiedUntil||Date.parse(verifiedUntil)<=Date.now()) { setVerificationError("Verify your administrator identity before changing an account role."); return; } if (!changeReason.trim()) { setVerificationError("Enter a reason before changing an account role."); return; } void mutate(id, () => updateUserRole(id, role, changeReason.trim()), "Role updated."); }} updatingUserId={updatingUserId} users={visibleUsers} /> : <EmptyState compact message={users.length?"Clear the search to see available accounts.":"Users appear here after they sign in with GitHub."} title={users.length?"No matching users":"No users yet"} />}
    </section> : null}

    {!loading && activeTab === "projects" ? <section className="admin-section" data-admin-project-state-source="current-state" data-admin-section="projects" id="admin-panel-projects">
      <div className="form-grid"><label className="field"><span>Search authorized project records</span><input type="search" value={recordSearch} onChange={(event)=>setRecordSearch(event.target.value)}/></label><label className="field"><span>Project organization</span><select aria-label="Project organization" value={organizationFilter} onChange={(event)=>setOrganizationFilter(event.target.value)}><option value="">All authorized organizations</option>{organizations.map((organization)=><option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></label></div>
      {sourceErrors.projects ? <AdminSectionFailure failure={sourceErrors.projects} onRetry={load} title="Project operation evidence unavailable" /> : <>
        <div aria-label="Recorded project failure filter" className="segmented" role="group">{["ALL", "FAILED"].map((filter) => <button aria-pressed={projectFilter === filter} key={filter} onClick={() => setProjectFilter(filter)} type="button">{filter === "ALL" ? "All" : "Recorded failure"}<span className="count">{projectCounts[filter] || 0}</span></button>)}</div>
        {filteredProjects.length ? <DataTable caption="Projects and their latest recorded operation" label="Projects and operations"><thead><tr><th>Project</th><th>Organization</th><th>State</th><th>Latest operation</th><th>Updated</th></tr></thead><tbody>{filteredProjects.map(({ project, currentState }) => {
          const state = projectStatePresentation(currentState);
          const organization=organizationById.get(project.organizationId);
          const latest = currentState?.latestAttempt || currentState?.stateAuthority?.latestCompletedOperation;
          const operation = latest?.operationId || latest?.id;
          const operationType = latest?.operationType || latest?.type || latest?.deploymentAction || latest?.metadata?.deploymentAction;
          const updated = currentState?.stateAuthority?.reconciliation?.lastReconciledAt || currentState?.latestAttempt?.occurredAt;
          return <tr data-authoritative-state={state.state} key={project.id}>
            <td data-label="Project"><strong>{project.name || project.repositoryFullName}</strong><span className="cell-sub mono">{project.id}</span></td>
            <td data-label="Organization">{organization?.name||"Organization identity unavailable"}<span className="cell-sub mono">{project.organizationId||"Ownership unverified"}</span></td>
            <td data-label="State">{currentState ? <Status active={state.active} tone={state.state === "FAILED" ? "danger" : projectStateTone(state.state)}>{projectStateLabel(state.state)}</Status> : <span>Recorded: {label(project.status)}<span className="cell-sub">Runtime health requires authorized support access.</span></span>}</td>
            <td data-label="Latest operation">{project.operationStatus ? label(project.operationStatus) : operationType ? label(operationType) : "None"}{operation || project.operationId ? <span className="cell-sub mono" title={operation || project.operationId}>{String(operation || project.operationId).slice(0, 12)}</span> : null}</td>
            <td data-label="Updated">{updated || project.operationUpdatedAt ? <Time value={updated || project.operationUpdatedAt} /> : "—"}</td>
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
