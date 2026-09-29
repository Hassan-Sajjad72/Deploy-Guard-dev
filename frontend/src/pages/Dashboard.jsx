import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getWorkspaceSummary } from "../api/projectApi.js";
import AppIcon from "../components/common/AppIcon.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { StatusBadge } from "../components/common/Premium.jsx";
import { useAuth } from "../hooks/useAuth.js";
import { formatRelativeTime } from "../utils/time.js";
import { projectStatePresentation } from "../utils/projectStatePresentation.js";
import { conciseProjectSummary } from "../utils/overviewLifecyclePresentation.js";
import "../styles/pages/home.css";

export default function Dashboard() {
  const { role } = useAuth();
  const [summaries, setSummaries] = useState([]);
  const [usage, setUsage] = useState(null);
  const [workspace, setWorkspace] = useState({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try { const response = await getWorkspaceSummary(); setSummaries(response.summaries || []); setUsage(response.usage || null); setWorkspace(response); setError(""); }
    catch (caught) { setError(caught.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const hasActiveOperation = summaries.some(({ currentState }) => projectStatePresentation(currentState).active);
  useEffect(() => {
    if (!hasActiveOperation) return undefined;
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(refresh, 8000);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [hasActiveOperation, load]);

  const view = useMemo(() => {
    const active = summaries.filter(({ currentState }) => projectStatePresentation(currentState).active);
    const live = summaries.filter(({ currentState }) => !projectStatePresentation(currentState).active && projectStatePresentation(currentState).state === "LIVE" && Boolean(currentState?.stableRelease));
    const attention = workspace.needsAttention || [];
    return { active, attention, live };
  }, [summaries, workspace]);

  const liveCount = view.live.length;
  const total = usage?.totalProjects ?? summaries.length;
  return <div className="workspace-page dashboard-page dg-home">
    <section className="dg-home-hero dg-dark" aria-label="Workspace status">
      <div className="dg-home-hero-copy">
        <h1>Home</h1>
        <p>See active deployments and projects that need attention.</p>
        <div className="dg-home-actions"><Link className="dg-home-secondary" to="/projects">All projects</Link>{role !== "readonly" ? <Link className="button dg-home-primary" to="/projects/new"><AppIcon name="plus" size={16} />Create project</Link> : null}</div>
      </div>
      {!loading && summaries.length ? <dl aria-label="Workspace summary" className="dg-home-summary">
        <div><dt>Projects</dt><dd>{total}</dd></div>
        <div><dt>Live</dt><dd>{liveCount}</dd></div>
        <div><dt>Deploying</dt><dd>{view.active.length}</dd></div>
        <div><dt>Needs attention</dt><dd>{view.attention.length}</dd></div>
      </dl> : null}
    </section>
    {error ? <ErrorState message={error} /> : null}{loading ? <LoadingState message="Loading workspace…" /> : null}
    {!loading && !summaries.length && !error ? <section className="dg-home-empty"><span className="dg-home-empty-mark"><AppIcon name="github" size={24} /></span><div><h2>Create your first project</h2><p>Connect a GitHub repository and configure the application before deployment.</p></div>{role !== "readonly" ? <Link className="button dg-home-primary" to="/projects/new">Create Project</Link> : null}</section> : null}
    {!loading && summaries.length ? <>
      <div className="dg-home-grid">
        <div className="dg-home-main">
          <section aria-labelledby="home-attention" className="dg-home-panel">
            <header><div><h2 id="home-attention">Needs attention</h2><p>Projects requiring action.</p></div><span className={view.attention.length ? "dg-home-count is-danger" : "dg-home-count"}>{view.attention.length}</span></header>
            <ul className="dg-home-rows">{view.attention.map(({ project, currentState }) => <li className="dg-home-row is-attention" key={project.id}>
              <span aria-hidden="true" className="dg-home-row-mark" />
              <span className="dg-home-row-identity"><strong>{project.name}</strong><small>{conciseProjectSummary(currentState)}</small></span>
              <StatusBadge status={currentState?.developerState || "platform_attention"} />
              <Link className="dg-home-row-action" to={`/projects/${project.id}`}>Open project</Link>
            </li>)}</ul>
            {!view.attention.length ? <p className="dg-home-empty-line"><AppIcon name="check" size={15} />No projects need attention.</p> : null}
          </section>
          <section aria-labelledby="home-active" className="dg-home-panel">
            <header><div><h2 id="home-active">Active deployments</h2><p>Deployments currently running or queued.</p></div><span className={view.active.length ? "dg-home-count is-active" : "dg-home-count"}>{view.active.length}</span></header>
            <ul className="dg-home-rows">{view.active.map(({ project, currentState }) => <li className="dg-home-row is-active" data-workspace-release={currentState.developerState} key={project.id}>
              <span aria-hidden="true" className="dg-home-row-pulse" />
              <span className="dg-home-row-identity"><strong>{project.name}</strong><small>{currentState.progress?.label || "Preparing"}</small></span>
              <StatusBadge status={currentState.developerState} />
              <Link className="dg-home-row-action" to={`/projects/${project.id}/pipeline`}>Open <AppIcon name="arrow" size={14} /></Link>
            </li>)}</ul>
            {!view.active.length ? <p className="dg-home-empty-line">No deployments currently running.</p> : null}
          </section>
        </div>
        {workspace.recentlyViewed?.length ? <aside aria-labelledby="home-recent" className="dg-home-recent">
          <header><div><h2 id="home-recent">Recently used projects</h2></div></header>
          <ul>{workspace.recentlyViewed.slice(0, 5).map(({ project }) => <li key={project.id}><Link to={`/projects/${project.id}`}>
            <span aria-hidden="true" className="dg-home-recent-mark">{String(project.name || "?").charAt(0).toUpperCase()}</span>
            <span className="dg-home-row-identity"><strong>{project.name}</strong><small>Viewed {formatRelativeTime(project.activity?.lastViewedAt)}</small></span>
            <AppIcon name="chevron" size={15} />
          </Link></li>)}</ul>
          <Link className="dg-home-recent-all" to="/projects">View all projects</Link>
        </aside> : null}
      </div>
    </> : null}
  </div>;
}
