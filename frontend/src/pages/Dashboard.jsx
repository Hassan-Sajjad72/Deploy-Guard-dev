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

export default function Dashboard() {
  const { role } = useAuth();
  const [summaries, setSummaries] = useState([]);
  const [usage, setUsage] = useState(null);
  const [releaseSummary, setReleaseSummary] = useState(null);
  const [workspace, setWorkspace] = useState({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try { const response = await getWorkspaceSummary(); if (mounted) { setSummaries(response.summaries || []); setUsage(response.usage || null); setReleaseSummary(response.releaseSummary || null); setWorkspace(response); setError(""); } }
      catch (caught) { if (mounted) setError(caught.message); }
      finally { if (mounted) setLoading(false); }
    }
    load(); const timer = window.setInterval(load, 8000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);

  const view = useMemo(() => {
    const active = summaries.filter(({ currentState }) => projectStatePresentation(currentState).active);
    const live = summaries.filter(({ currentState }) => currentState?.developerState === "live" && Boolean(currentState?.stableUrl));
    return { active, live, next: workspace.continueWorking || active[0] || summaries[0] || null };
  }, [summaries, workspace]);

  return <div className="workspace-page dashboard-page">
    <header className="workspace-heading"><div><p className="eyebrow">Workspace</p><h1>Deployments</h1><p>Monitor active releases and continue projects that need attention.</p></div>{role !== "readonly" ? <Link className="button" to="/projects/new"><AppIcon name="plus" size={16} />Create Project</Link> : null}</header>
    {error ? <ErrorState message={error} /> : null}{loading ? <LoadingState message="Loading deployments…" /> : null}
    {!loading && !summaries.length && !error ? <section className="workspace-empty-state"><div className="empty-orbit"><AppIcon name="github" size={28} /></div><h2>Create your first project</h2><p>Connect a GitHub repository and configure the application before deployment.</p>{role !== "readonly" ? <Link className="button" to="/projects/new">Create Project</Link> : null}</section> : null}
    {!loading && summaries.length ? <>
      <section className="workspace-stat-strip" aria-label="Deployment summary"><div><span>Total projects</span><strong>{usage?.totalProjects ?? summaries.length}</strong></div><div><span>Active projects</span><strong>{usage?.activeProjects ?? summaries.length}</strong></div><div><span>Active runs</span><strong className={usage?.activeRuns ? "text-info" : ""}>{usage?.activeRuns ?? 0}</strong></div><div><span>Stable releases</span><strong>{releaseSummary?.stableProjects ?? 0}</strong></div><div><span>Needs attention</span><strong>{releaseSummary?.blockedOrFailedV1Releases ?? 0}</strong></div></section>
      <div className="dashboard-focus-grid dashboard-focus-grid-restored">
        {view.next ? <section className="continue-deployment-card" data-workspace-release={view.next.currentState?.developerState}><div className="deployment-card-top"><span className="project-glyph"><AppIcon name="box" size={18} /></span><StatusBadge status={view.next.currentState?.developerState || "unknown"} /></div><div><p className="eyebrow">Continue working</p><h2>{view.next.project.name}</h2><p>{view.next.currentState?.developerMessage || "Open the project to continue."}</p><small>Worked on {formatRelativeTime(view.next.project.activity?.lastMeaningfulActivityAt || view.next.project.createdAt)}</small></div><Link className="button" to={`/projects/${view.next.project.id}`}>Continue <AppIcon name="arrow" size={15} /></Link></section> : null}
        <section className="active-runs-card panel-flat"><div className="compact-section-heading"><div><p className="eyebrow">Automation</p><h2>Active runs</h2></div><span className="count-chip">{view.active.length}</span></div><div className="active-run-list">{view.active.map(({ project, currentState }) => { const release = normalReleaseView(currentState); return <article className="active-run-item" data-workspace-release={currentState.developerState} key={project.id}><span className="run-status-ring" /><span className="active-run-identity"><strong>{project.name}</strong><small>{currentState.progress?.label || "Preparing"}</small></span><StatusBadge status={currentState.developerState} /><span className="active-run-progress"><i style={{ width: `${release?.progress ?? 0}%` }} /><small>{release?.progress ?? 0}%</small></span><Link className="text-link" to={`/projects/${project.id}/pipeline`}>Open <AppIcon name="arrow" size={14} /></Link></article>; })}{!view.active.length ? <div className="calm-empty"><span className="success-check"><AppIcon name="check" size={15} /></span><div><strong>No active runs</strong><p>Queued and running deployments will appear here.</p></div></div> : null}</div></section>
      </div>
      {workspace.needsAttention?.length ? <section className="panel-flat"><div className="compact-section-heading"><div><p className="eyebrow">Needs attention</p><h2>Unresolved projects</h2></div><span className="count-chip">{workspace.needsAttention.length}</span></div><div className="active-run-list">{workspace.needsAttention.map(({ project, currentState }) => <article className="active-run-item" key={project.id}><span className="active-run-identity"><strong>{project.name}</strong><small>{currentState?.developerMessage}</small></span><StatusBadge status={currentState?.developerState || "platform_attention"} /><Link className="text-link" to={`/projects/${project.id}`}>Open project</Link></article>)}</div></section> : null}
      {workspace.recentlyViewed?.length ? <section className="panel-flat"><div className="compact-section-heading"><div><p className="eyebrow">Recently viewed</p><h2>Project history</h2></div></div><div className="active-run-list">{workspace.recentlyViewed.slice(0, 5).map(({ project }) => <article className="active-run-item" key={project.id}><span className="active-run-identity"><strong>{project.name}</strong><small>Viewed {formatRelativeTime(project.activity?.lastViewedAt)}</small></span><Link className="text-link" to={`/projects/${project.id}`}>Open</Link></article>)}</div></section> : null}
      {view.live.length ? <section className="panel-flat"><div className="compact-section-heading"><div><p className="eyebrow">Live projects</p><h2>Verified applications</h2></div><span className="count-chip">{view.live.length}</span></div><div className="active-run-list">{view.live.map(({ project, currentState }) => <article className="active-run-item" data-workspace-release="live" key={project.id}><span className="active-run-identity"><strong>{project.name}</strong><small>Stable release {currentState.stableRelease?.revision}</small></span><StatusBadge status="live">Live</StatusBadge><a className="text-link" href={currentState.stableUrl} rel="noreferrer" target="_blank">Open app</a></article>)}</div></section> : null}
    </> : null}
  </div>;
}
