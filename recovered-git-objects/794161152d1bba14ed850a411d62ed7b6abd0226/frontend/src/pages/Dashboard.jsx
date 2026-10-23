import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getWorkspaceSummary } from "../api/projectApi.js";
import AppIcon from "../components/common/AppIcon.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { StatusBadge } from "../components/common/Premium.jsx";
import { useAuth } from "../hooks/useAuth.js";

export default function Dashboard() {
  const { role } = useAuth();
  const [summaries, setSummaries] = useState([]);
  const [usage, setUsage] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try { const response = await getWorkspaceSummary(); if (mounted) { setSummaries(response.summaries || []); setUsage(response.usage || null); setError(""); } }
      catch (caught) { if (mounted) setError(caught.message); }
      finally { if (mounted) setLoading(false); }
    }
    load(); const timer = window.setInterval(load, 8000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);

  const view = useMemo(() => {
    const active = summaries.filter(({ currentState }) => Number(currentState?.activeRunCount || 0) > 0);
    const attention = summaries.filter(({ currentState }) => ["failed", "blocked", "paused"].includes(currentState?.overallStatus) || currentState?.adminActionRequired || ["unhealthy", "stale_live_record", "failed"].includes(currentState?.deploymentStatus));
    const live = summaries.filter(({ currentState }) => currentState?.deploymentStatus === "live" && currentState?.cloudVerificationStatus === "verified");
    const next = active[0] || attention[0] || summaries[0] || null;
    return { active, attention, live, next };
  }, [summaries]);

  return <div className="workspace-page dashboard-page">
    <header className="workspace-heading"><div><p className="eyebrow">Workspace</p><h1>Deployments</h1><p>Monitor active releases and continue projects that need attention.</p></div>{role !== "readonly" ? <Link className="button" to="/projects/new"><AppIcon name="plus" size={16} />Create Project</Link> : null}</header>
    {error ? <ErrorState message={error} /> : null}{loading ? <LoadingState message="Loading deployments…" /> : null}
    {!loading && !summaries.length && !error ? <section className="workspace-empty-state"><div className="empty-orbit"><AppIcon name="github" size={28} /></div><h2>Create your first project</h2><p>Connect a GitHub repository and configure the application before deployment.</p>{role !== "readonly" ? <Link className="button" to="/projects/new">Create Project</Link> : null}</section> : null}
    {!loading && summaries.length ? <>
      <section className="workspace-stat-strip" aria-label="Deployment summary"><div><span>Total projects</span><strong>{usage?.totalProjects ?? summaries.length}</strong></div><div><span>Active projects</span><strong>{usage?.activeProjects ?? summaries.length}</strong></div><div><span>Active runs</span><strong className={usage?.activeRuns ? "text-info" : ""}>{usage?.activeRuns ?? 0}</strong></div><div><span>{usage?.enforcement?.enabled === false ? "Project usage (testing)" : "Plan project usage"}</span><strong>{usage ? (usage.enforcement?.enabled === false ? `${usage.activeProjects} · not enforced` : `${usage.activeProjects} / ${usage.projectLimit}`) : "—"}</strong></div></section>
      <div className="dashboard-focus-grid dashboard-focus-grid-restored">
        {view.next ? <section className="continue-deployment-card"><div className="deployment-card-top"><span className="project-glyph"><AppIcon name="box" size={18} /></span><StatusBadge status={view.next.currentState?.overallStatus || "unknown"} /></div><div><p className="eyebrow">Continue where you left off</p><h2>{view.next.project.name}</h2><p>{view.next.currentState?.userFacingStatus || "Open the project to continue its deployment."}</p></div><div className="continue-progress"><div><span>{view.next.currentState?.currentStepLabel || "Ready"}</span><strong>{view.next.currentState?.progressPercentage || 0}%</strong></div><div className="progress-track"><span style={{ width: `${view.next.currentState?.progressPercentage || 0}%` }} /></div></div><Link className="button" to={`/projects/${view.next.project.id}`}>Open project <AppIcon name="arrow" size={15} /></Link></section> : null}
        <section className="active-runs-card panel-flat"><div className="compact-section-heading"><div><p className="eyebrow">Automation</p><h2>Active runs</h2></div><span className="count-chip">{view.active.reduce((total, item) => total + Number(item.currentState?.activeRunCount || 0), 0)}</span></div><div className="active-run-list">{view.active.map(({ project, currentState }) => <article className="active-run-item" key={project.id}><span className="run-status-ring" /><span className="active-run-identity"><strong>{project.name}</strong><small>{currentState.activeRun?.currentStepLabel || currentState.currentStepLabel}</small></span><StatusBadge status={currentState.activeRun?.status || "running"} /><span className="active-run-progress"><i style={{ width: `${currentState.progressPercentage || 0}%` }} /><small>{currentState.progressPercentage || 0}%</small></span><Link className="text-link" to={`/projects/${project.id}/pipeline`}>Open <AppIcon name="arrow" size={14} /></Link></article>)}{!view.active.length ? <div className="calm-empty"><span className="success-check"><AppIcon name="check" size={15} /></span><div><strong>No active runs</strong><p>Queued and running deployments will appear here.</p></div></div> : null}</div></section>
      </div>
    </> : null}
  </div>;
}
