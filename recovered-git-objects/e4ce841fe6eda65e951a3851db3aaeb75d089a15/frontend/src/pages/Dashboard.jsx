import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getWorkspaceSummary } from "../api/projectApi.js";
import AppIcon from "../components/common/AppIcon.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { useAuth } from "../hooks/useAuth.js";
import { normalReleaseView } from "../utils/normalReleaseView.js";
import { projectStatePresentation } from "../utils/projectStatePresentation.js";
import { conciseProjectSummary } from "../utils/overviewLifecyclePresentation.js";
import "../styles/pages/home.css";

export default function Dashboard() {
  const { role } = useAuth();
  const [summaries, setSummaries] = useState([]);
  const [workspace, setWorkspace] = useState({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try { const response = await getWorkspaceSummary(); setSummaries(response.summaries || []); setWorkspace(response); setError(""); }
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
  return <div className="workspace-page dashboard-page dg-home">
    <header className="dg-home-hero" aria-label="Workspace status">
      <div className="dg-home-hero-copy">
        <h1>Home</h1>
        <p>Projects and deployments needing attention.</p>
        <div className="dg-home-actions"><Link className="dg-home-secondary" to="/projects">All projects</Link>{role !== "readonly" ? <Link className="button dg-home-primary" to="/projects/new"><AppIcon name="plus" size={16} />Create project</Link> : null}</div>
        {!loading && summaries.length ? <p className="dg-home-summary">{view.attention.length ? `${view.attention.length} project${view.attention.length === 1 ? " needs" : "s need"} attention.` : view.active.length ? `${view.active.length} deployment${view.active.length === 1 ? " is" : "s are"} in progress.` : `${liveCount} project${liveCount === 1 ? " is" : "s are"} live.`}</p> : null}
      </div>
    </header>
    {error ? <ErrorState message={error} /> : null}{loading ? <LoadingState message="Loading workspace…" /> : null}
    {!loading && !summaries.length && !error ? <section className="dg-home-empty"><span className="dg-home-empty-mark"><AppIcon name="github" size={24} /></span><div><h2>Create your first project</h2><p>Connect a GitHub repository and configure the application before deployment.</p></div>{role !== "readonly" ? <Link className="button dg-home-primary" to="/projects/new">Create Project</Link> : null}</section> : null}
    {!loading && summaries.length ? <>
      <div className="dg-home-main">
        {view.attention.length ?
          <section aria-labelledby="home-attention" className="dg-home-panel">
            <header><div><h2 id="home-attention">Needs attention</h2></div><span className="dg-home-count is-danger">{view.attention.length}</span></header>
            <ul className="dg-home-rows">{view.attention.map(({ project, currentState }) => <li className="dg-home-row is-attention" key={project.id}>
              <span aria-hidden="true" className="dg-home-row-mark" />
              <span className="dg-home-row-identity"><strong>{project.name}</strong><small>{conciseProjectSummary(currentState)}</small></span>
              <Link className="dg-home-row-action" to={`/projects/${project.id}`}>Open project</Link>
            </li>)}</ul>
          </section> : null}
        {view.active.length ?
          <section aria-labelledby="home-active" className="dg-home-panel">
            <header><div><h2 id="home-active">Active deployments</h2></div><span className="dg-home-count is-active">{view.active.length}</span></header>
            <ul className="dg-home-rows">{view.active.map(({ project, currentState }) => { const release = normalReleaseView(currentState); return <li className="dg-home-row is-active" data-workspace-release={currentState.developerState} key={project.id}>
              <span aria-hidden="true" className="dg-home-row-pulse" />
              <span className="dg-home-row-identity"><strong>{project.name}</strong><small>{currentState.progress?.label || "Preparing"}</small></span>
              <span className="dg-home-progress"><span><i style={{ width: `${release?.progress ?? 0}%` }} /></span><small>{release?.progress ?? 0}%</small></span>
              <Link className="dg-home-row-action" to={`/projects/${project.id}/pipeline`}>Open <AppIcon name="arrow" size={14} /></Link>
            </li>; })}</ul>
          </section> : null}
      </div>
    </> : null}
  </div>;
}
