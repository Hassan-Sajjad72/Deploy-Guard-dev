import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { getWorkspaceSummary } from "../api/projectApi.js";
import AppIcon from "../components/common/AppIcon.jsx";
import { Button, Callout, EmptyState, PageHeader, Status } from "../components/common/DesignSystem.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import Time from "../components/common/Time.jsx";
import { useAuth } from "../hooks/useAuth.js";
import { normalReleaseView } from "../utils/normalReleaseView.js";
import { conciseProjectSummary } from "../utils/overviewLifecyclePresentation.js";
import { liveWithFailedLatest, projectStateLabel, projectStatePresentation, projectStateTone } from "../utils/projectStatePresentation.js";
import { productText } from "../utils/productTerms.js";
import { getAgencyPortfolio, getWorkspaces } from "../api/workspaceApi.js";
import { dashboardEvidence, dashboardScopeMatches, dashboardTotals } from "../utils/organizationDashboard.js";
import "../styles/organization-dashboard.css";

const filters = [
  ["ALL", "All"],
  ["ATTENTION", "Needs attention"],
  ["DEPLOYING", "Deploying"],
  ["LIVE", "Live"],
];

/** One short line that explains why a project needs attention. */
function attentionReason(currentState) {
  if (currentState?.stateAuthority?.applicationHealth?.status === "failed") return "The application health check failed.";
  if (liveWithFailedLatest(currentState)) return "Last deployment failed. The previous release is still live.";
  const diagnosis = currentState?.latestAttempt?.diagnosis;
  return productText(diagnosis?.summary) || conciseProjectSummary(currentState);
}

/*
 * The workspace home: one project list. Projects that need attention or are
 * deploying sort first and carry their reason or progress inline, so nothing
 * is listed twice.
 */
export default function Projects() {
  const { role } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [summaries, setSummaries] = useState([]);
  const [attentionIds, setAttentionIds] = useState(() => new Set());
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [stateFilter, setStateFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [portfolioFilter, setPortfolioFilter] = useSearchParams();
  const [workspaces,setWorkspaces]=useState([]),[portfolio,setPortfolio]=useState({clients:[],engagements:[]}),[directoryError,setDirectoryError]=useState(""),[portfolioError,setPortfolioError]=useState("");
  const generation=useRef(0);
  const organizationId=portfolioFilter.get("organizationId")||"",environment=portfolioFilter.get("environment")||"";
  const clientId = portfolioFilter.get("clientId");
  const engagementId = portfolioFilter.get("engagementId");
  const inferredOrganizationId=organizationId||summaries.find(({project})=>(clientId&&project.clientId===clientId)||(engagementId&&project.engagementId===engagementId))?.project.organizationId||"";
  const workspace=workspaces.find((item)=>item.id===inferredOrganizationId);
  function scopeChange(key,value){const next=new URLSearchParams(portfolioFilter);if(value)next.set(key,value);else next.delete(key);if(key==="organizationId"){next.delete("clientId");next.delete("engagementId");next.delete("environment");}if(key==="clientId")next.delete("engagementId");setPortfolioFilter(next);}
  function clearFilters(){setSearch("");setStateFilter("ALL");setPortfolioFilter({});}

  useEffect(()=>{let active=true;getWorkspaces().then((result)=>{if(active){setWorkspaces(result.workspaces||[]);setDirectoryError("");}}).catch((caught)=>{if(active)setDirectoryError(caught.message);});return()=>{active=false;};},[]);
  useEffect(()=>{let active=true;setPortfolio({clients:[],engagements:[]});setPortfolioError("");if(workspace?.kind==="agency")getAgencyPortfolio(workspace.id).then((result)=>{if(active)setPortfolio(result);}).catch((caught)=>{if(active)setPortfolioError(caught.message);});return()=>{active=false;};},[workspace?.id,workspace?.kind]);

  const load = useCallback(async () => {
    const current=++generation.current;
    try {
      const response = await getWorkspaceSummary();
      if(current!==generation.current)return;
      setSummaries(response.summaries || []);
      setAttentionIds(new Set((response.needsAttention || []).map(({ project }) => project?.id)));
      setError("");
    } catch (caught) {
      if(current===generation.current)setError(caught.message);
    } finally {
      if(current===generation.current)setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      generation.current++;
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  useEffect(() => {
    if (!location.state?.notice) return undefined;
    const timer = window.setTimeout(() => navigate(location.pathname, { replace: true, state: null }), 4200);
    return () => window.clearTimeout(timer);
  }, [location.pathname, location.state?.notice, navigate]);

  const rows = useMemo(() => summaries.map((summary) => {
    const presentation = projectStatePresentation(summary.currentState);
    const attention = attentionIds.has(summary.project.id) || dashboardEvidence(summary).alert;
    const rank = attention ? 0 : presentation.active ? 1 : 2;
    return { ...summary, presentation, attention, rank };
  }).sort((left, right) => left.rank - right.rank), [attentionIds, summaries]);

  const hasActiveOperation = rows.some(({ presentation }) => presentation.active);
  useEffect(() => {
    if (!hasActiveOperation) return undefined;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 8000);
    return () => window.clearInterval(timer);
  }, [hasActiveOperation, load]);

  const scopedRows=useMemo(()=>rows.filter((row)=>dashboardScopeMatches(row,{organizationId,environment,clientId,engagementId})),[rows,organizationId,environment,clientId,engagementId]);
  const scopeTotals=useMemo(()=>dashboardTotals(scopedRows),[scopedRows]);
  const counts = useMemo(() => scopedRows.reduce((totals, { presentation, attention }) => {
    const next = { ...totals, [presentation.state]: (totals[presentation.state] || 0) + 1 };
    if (attention) next.ATTENTION = (next.ATTENTION || 0) + 1;
    return next;
  }, { ALL: scopedRows.length }), [scopedRows]);

  const visible = useMemo(() => scopedRows.filter(({ project, currentState, presentation, attention }) => {
    const matchesState = stateFilter === "ALL" || (stateFilter === "ATTENTION" ? attention : presentation.state === stateFilter);
    const haystack = `${project.name} ${currentState?.repository || project.repositoryFullName || ""} ${currentState?.branch || project.targetBranch || ""}`.toLowerCase();
    return matchesState && haystack.includes(search.trim().toLowerCase());
  }), [scopedRows, search, stateFilter]);

  const summaryLine = [
    counts.ATTENTION ? `${counts.ATTENTION} need${counts.ATTENTION === 1 ? "s" : ""} attention` : null,
    counts.DEPLOYING ? `${counts.DEPLOYING} deploying` : null,
    counts.LIVE ? `${counts.LIVE} live` : null,
  ].filter(Boolean).join(" · ");
  const canDeploy = role !== "readonly";

  return <div className="page projects-page">
    <PageHeader
      actions={canDeploy && rows.length ? <Button icon="plus" to="/deploy" tone="primary">New deployment</Button> : null}
      description={loading ? "Loading your projects…" : rows.length ? summaryLine || `${rows.length} project${rows.length === 1 ? "" : "s"}` : "Repositories you deploy with DeployGuard."}
      title="Projects"
    />
    {location.state?.notice ? <Callout tone="success">{location.state.notice}</Callout> : null}
    {!loading&&!error?<section aria-label="Organization dashboard" className="organization-dashboard"><h2>{workspace?.name||"All authorized workspaces"}</h2>
      <div className="organization-dashboard-filters"><label>Workspace<select aria-label="Workspace" value={organizationId} onChange={(event)=>scopeChange("organizationId",event.target.value)}><option value="">All authorized workspaces</option>{workspaces.map((item)=><option key={item.id} value={item.id}>{item.name}{item.archivedAt?" · Archived":""}</option>)}</select></label>
        <label>Environment<select aria-label="Environment" value={environment} onChange={(event)=>scopeChange("environment",event.target.value)}><option value="">All environments</option>{[...new Set(rows.filter((row)=>dashboardScopeMatches(row,{organizationId,clientId,engagementId})).map(({project})=>project.environmentName).filter(Boolean))].sort().map((name)=><option key={name} value={name}>{name}</option>)}</select></label>
        {workspace?.kind==="agency"?<><label>Client<select aria-label="Client" value={clientId||""} onChange={(event)=>scopeChange("clientId",event.target.value)}><option value="">All clients</option>{portfolio.clients.map((item)=><option key={item.id} value={item.id}>{item.name}{item.archivedAt?" · Archived":""}</option>)}</select></label><label>Engagement<select aria-label="Engagement" value={engagementId||""} onChange={(event)=>scopeChange("engagementId",event.target.value)}><option value="">All engagements</option>{portfolio.engagements.filter((item)=>!clientId||item.clientId===clientId).map((item)=><option key={item.id} value={item.id}>{item.name}{item.archivedAt?" · Archived":""}</option>)}</select></label></>:null}
      </div>{directoryError?<p role="status">Workspace directory unavailable: {directoryError}</p>:null}{portfolioError?<p role="status">Client and engagement directory unavailable: {portfolioError}</p>:null}
      <dl className="organization-dashboard-totals" aria-label="Selected workspace totals">{[["Projects",scopeTotals.projects],["Environment names",scopeTotals.environments],["Verified releases",scopeTotals.verifiedReleases],["Healthy applications",scopeTotals.healthy],["Failed health checks",scopeTotals.failedHealth],["Health unverified",scopeTotals.unverifiedHealth],["Health pending",scopeTotals.pendingHealth],["Operational alerts",scopeTotals.alerts]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <p className="muted">Release identity and current application health are reported independently.</p>
      {workspace?<p><Link to="/workspaces">Manage workspace and AWS accounts</Link>{["owner","admin"].includes(workspace.role)?<> · <Link to={`/workspaces/${workspace.id}/entitlements`}>Review limits and usage</Link></>:null}</p>:null}
      {scopeTotals.alerts?<details className="disclosure"><summary>Operational alerts ({scopeTotals.alerts})</summary><ul>{scopedRows.filter((row)=>dashboardEvidence(row).alert).map(({project,currentState})=><li key={project.id}><Link to={`/projects/${project.id}`}>{project.name}</Link> · {project.environmentName||"Environment unverified"} · {attentionReason(currentState)}</li>)}</ul></details>:null}
    </section>:null}
    {error ? <ErrorState message={error} onRetry={() => void load()} title="Projects could not be loaded" /> : null}
    {loading ? <LoadingState inline message="Loading projects…" /> : null}
    {!loading && !error && !rows.length ? <EmptyState
      action={canDeploy ? <Button icon="github" to="/deploy" tone="primary">Deploy a repository</Button> : null}
      icon="deploy"
      message={canDeploy ? "Pick a GitHub repository and branch. DeployGuard builds it, runs it on AWS and tells you when something needs attention." : "No projects have been shared with you yet."}
      title="No projects yet"
    /> : null}
    {!loading && !error && rows.length ? <section aria-label="Projects" className="section">
      <div className="projects-toolbar">
        <label className="search projects-search"><span className="sr-only">Search projects</span><AppIcon name="search" size={16} /><input autoComplete="off" className="input" name="project-search" onChange={(event) => setSearch(event.target.value)} placeholder="Search by name, repository or branch" spellCheck={false} type="search" value={search} /></label>
        <div aria-label="Filter by state" className="segmented" role="group">
          {filters.filter(([value]) => value === "ALL" || counts[value]).map(([value, label]) => <button aria-pressed={stateFilter === value} key={value} onClick={() => setStateFilter(value)} type="button">{label}<span className="count">{counts[value] || 0}</span></button>)}
        </div>
      </div>
      {!visible.length ? <p className="muted projects-none">No projects match. <button className="btn-link btn" onClick={clearFilters} type="button">Clear filters</button></p> : <ul className="rows projects-list">
        {visible.map(({ project, currentState, presentation, attention }) => {
          const activity = project.activity?.lastMeaningfulActivityAt || currentState?.latestAttempt?.occurredAt || project.createdAt;
          const repository = currentState?.repository || project.repositoryFullName;
          const branch = currentState?.branch || project.targetBranch;
          const release = presentation.active ? normalReleaseView(currentState) : null;
          const degraded = liveWithFailedLatest(currentState);
          const tone = presentation.state === "FAILED" ? "danger" : projectStateTone(presentation.state);
          const evidence=dashboardEvidence({currentState,attention});
          return <li data-authoritative-state={presentation.state} key={project.id}>
            <Link className={`project-row${attention ? " is-attention" : ""}`} to={presentation.active ? `/projects/${project.id}/pipeline` : `/projects/${project.id}`}>
              <span className="project-state"><Status active={presentation.active} tone={tone}>{projectStateLabel(presentation.state)}</Status></span>
              <span className="project-identity">
                <strong translate="no">{project.name}</strong>
                <span className="project-dashboard-evidence">{workspaces.find((item)=>item.id===project.organizationId)?.name||"Workspace"} · {project.environmentName||"Environment unverified"}</span>
                <span className="project-source" translate="no">{repository ? <span className="truncate" title={repository}>{repository}</span> : null}{branch ? <span className="project-branch truncate" title={branch}><AppIcon name="branch" size={13} /><span>{branch}</span></span> : null}</span>
              </span>
              <span className="project-detail">
                <span className="project-dashboard-evidence">{evidence.release?`${evidence.releaseVerified?"Verified":"Recorded"} release ${String(evidence.release.commit||evidence.release.revision||"Unavailable").slice(0,12)}`:"No verified release"} · Health: {evidence.health==="unavailable"?"unverified":evidence.health}</span>
                {attention ? <span className={degraded ? "project-reason is-warn" : "project-reason is-bad"}><AppIcon name="alert" size={14} /><span>{attentionReason(currentState)}</span></span> : null}
                {release ? <span className="project-progress"><span aria-hidden="true" className="meter tone-info"><i style={{ width: `${release.progress ?? 0}%` }} /></span><span>{currentState?.progress?.label || "Preparing"}</span></span> : null}
              </span>
              <span className="project-time muted"><Time value={activity} /></span>
              <AppIcon className="project-chevron" name="chevron" size={16} />
            </Link>
          </li>;
        })}
      </ul>}
    </section> : null}
  </div>;
}
