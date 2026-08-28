import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getWorkspaceSummary } from "../api/projectApi.js";
import AppIcon from "../components/common/AppIcon.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { StatusBadge } from "../components/common/Premium.jsx";
import { useAuth } from "../hooks/useAuth.js";
import { normalReleaseView } from "../utils/normalReleaseView.js";
import { formatRelativeTime } from "../utils/time.js";
import { projectStatePresentation } from "../utils/projectStatePresentation.js";
import { conciseProjectSummary } from "../utils/overviewLifecyclePresentation.js";

export default function Dashboard() {
  const { role } = useAuth();
  const [summaries, setSummaries] = useState([]);
  const [usage, setUsage] = useState(null);
  const [workspace, setWorkspace] = useState({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try { const response = await getWorkspaceSummary(); if (mounted) { setSummaries(response.summaries || []); setUsage(response.usage || null); setWorkspace(response); setError(""); } }
      catch (caught) { if (mounted) setError(caught.message); }
      finally { if (mounted) setLoading(false); }
    }
    load(); const timer = window.setInterval(load, 8000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);

  const view = useMemo(() => {
    const active = summaries.filter(({ currentState }) => projectStatePresentation(currentState).active);
    const live = summaries.filter(({ currentState }) => !projectStatePresentation(currentState).active && projectStatePresentation(currentState).state === "LIVE" && Boolean(currentState?.stableRelease));
    const stable = summaries.filter(({ currentState }) => Boolean(currentState?.stableRelease));
    const attention = workspace.needsAttention || [];
    const hasDeploymentEvidence = summaries.some(({ currentState }) => Boolean(
      projectStatePresentation(currentState).operation
      || currentState?.latestAttempt
      || currentState?.stableRelease
      || currentState?.stateAuthority?.latestCompletedOperation
    ));
    return { active, attention, hasDeploymentEvidence, live, stable, next: workspace.continueWorking || active[0] || summaries[0] || null };
  }, [summaries, workspace]);

  return <div className="workspace-page dashboard-page">
    <header className="workspace-heading"><div><p className="eyebrow">Workspace</p><h1>Projects</h1><p>Track project readiness, active runs, and verified releases.</p></div>{role !== "readonly" ? <Link className="button" to="/projects/new"><AppIcon name="plus" size={16} />Create Project</Link> : null}</header>
    {error ? <ErrorState message={error} /> : null}{loading ? <LoadingState message="Loading workspace…" /> : null}
    {!loading && !summaries.length && !error ? <section className="workspace-empty-state"><div className="empty-orbit"><AppIcon name="github" size={28} /></div><h2>Create your first project</h2><p>Connect a GitHub repository and configure the application before deployment.</p>{role !== "readonly" ? <Link className="button" to="/projects/new">Create Project</Link> : null}</section> : null}
    {!loading && summaries.length ? <>
      <section className="workspace-stat-strip" aria-label="Workspace summary"><div><span>Total projects</span><strong>{usage?.totalProjects ?? summaries.length}</strong></div><div><span>Active projects</span><strong>{usage?.activeProjects ?? summaries.length}</strong></div><div><span>Active runs</span><strong className={view.active.length ? "text-info" : ""}>{view.active.length}</strong></div><div><span>Stable releases</span><strong>{view.stable.length}</strong></div><div><span>Live deployments</span><strong>{view.live.length}</strong></div><div><span>Readiness attention</span><strong>{view.attention.length}</strong></div></section>
      {!view.hasDeploymentEvidence ? <section className="panel-flat" data-dashboard-empty-deployments="true"><div className="calm-empty"><span className="success-check"><AppIcon name="box" size={15} /></span><div><strong>No deployment attempts yet</strong><p>These projects contain repository readiness information, but no deployment run or stable release has been recorded.</p></div></div></section> : null}
      <div className="dashboard-focus-grid dashboard-focus-grid-restored">
        {view.next ? <section className="continue-deployment-card" data-workspace-state={view.next.currentState?.developerState}><div className="deployment-card-top"><span className="project-glyph"><AppIcon name="box" size={18} /></span><StatusBadge status={view.next.currentState?.developerState || "unknown"} /></div><div><p className="eyebrow">Project readiness</p><h2>{view.next.project.name}</h2><p className="dashboard-summary-line">{conciseProjectSummary(view.next.currentState)}</p><small>{view.next.project.activity?.lastMeaningfulActivityAt ? `Project activity ${formatRelativeTime(view.next.project.activity.lastMeaningfulActivityAt)}` : `Project created ${formatRelativeTime(view.next.project.createdAt)}`}</small></div><Link className="button" to={`/projects/${view.next.project.id}`}>Review project <AppIcon name="arrow" size={15} /></Link></section> : null}
        <section className="active-runs-card panel-flat"><div className="compact-section-heading"><div><p className="eyebrow">Automation</p><h2>Active runs</h2></div><span className="count-chip">{view.active.length}</span></div><div className="active-run-list">{view.active.map(({ project, currentState }) => { const release = normalReleaseView(currentState); return <article className="active-run-item" data-workspace-release={currentState.developerState} key={project.id}><span className="run-status-ring" /><span className="active-run-identity"><strong>{project.name}</strong><small>{currentState.progress?.label || "Preparing"}</small></span><StatusBadge status={currentState.developerState} /><span className="active-run-progress"><span><i style={{ width: `${release?.progress ?? 0}%` }} /></span><small>{release?.progress ?? 0}%</small></span><Link className="text-link" to={`/projects/${project.id}/pipeline`}>Open <AppIcon name="arrow" size={14} /></Link></article>; })}{!view.active.length ? <div className="calm-empty"><span className="success-check"><AppIcon name="check" size={15} /></span><div><strong>No active runs</strong><p>Queued and running deployments will appear here.</p></div></div> : null}</div></section>
      </div>
      {view.attention.length ? <section className="panel-flat"><div className="compact-section-heading"><div><p className="eyebrow">Readiness attention</p><h2>Unresolved projects</h2></div><span className="count-chip">{view.attention.length}</span></div><div className="active-run-list">{view.attention.map(({ project, currentState }) => <article className="active-run-item" key={project.id}><span className="active-run-identity"><strong>{project.name}</strong><small>{conciseProjectSummary(currentState)}</small></span><StatusBadge status={currentState?.developerState || "platform_attention"} /><Link className="text-link" to={`/projects/${project.id}`}>Open project</Link></article>)}</div></section> : null}
      {workspace.recentlyViewed?.length ? <section className="panel-flat"><div className="compact-section-heading"><div><p className="eyebrow">Recently viewed</p><h2>Project history</h2></div></div><div className="active-run-list">{workspace.recentlyViewed.slice(0, 5).map(({ project }) => <article className="active-run-item" key={project.id}><span className="active-run-identity"><strong>{project.name}</strong><small>Viewed {formatRelativeTime(project.activity?.lastViewedAt)}</small></span><Link className="text-link" to={`/projects/${project.id}`}>Open</Link></article>)}</div></section> : null}
      {view.live.length ? <section className="panel-flat"><div className="compact-section-heading"><div><p className="eyebrow">Live projects</p><h2>Verified applications</h2></div><span className="count-chip">{view.live.length}</span></div><div className="active-run-list">{view.live.map(({ project, currentState }) => <article className="active-run-item" data-workspace-release="live" key={project.id}><span className="active-run-identity"><strong>{project.name}</strong><small>Stable release {currentState.stableRelease?.revision}</small></span><StatusBadge status="live">Live</StatusBadge>{currentState.stableUrl ? <a className="text-link" href={currentState.stableUrl} rel="noreferrer" target="_blank">Open app</a> : <span className="muted">Endpoint unavailable</span>}</article>)}</div></section> : null}
    </> : null}
  </div>;
}
