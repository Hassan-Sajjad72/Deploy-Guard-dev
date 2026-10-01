import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getWorkspaceSummary } from "../api/projectApi.js";
import AppIcon from "../components/common/AppIcon.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { StatusBadge } from "../components/common/Premium.jsx";
import { useAuth } from "../hooks/useAuth.js";
import { normalReleaseView } from "../utils/normalReleaseView.js";
import { formatRelativeTime } from "../utils/time.js";
import { projectStatePresentation, projectStateTone } from "../utils/projectStatePresentation.js";
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
    const hasDeploymentEvidence = summaries.some(({ currentState }) => Boolean(
      projectStatePresentation(currentState).operation
      || currentState?.latestAttempt
      || currentState?.stableRelease
      || currentState?.stateAuthority?.latestCompletedOperation
    ));
    return { active, attention, hasDeploymentEvidence, live };
  }, [summaries, workspace]);

  const liveCount = view.live.length;
  const total = usage?.totalProjects ?? summaries.length;
  return <div className="workspace-page dashboard-page dg-home">
    <section className="dg-home-hero dg-dark" aria-label="Workspace status">
      <div className="dg-home-hero-copy">
        <p className="dg-home-kicker"><span aria-hidden="true" className="dg-home-kicker-dot" />Workspace · Command center</p>
        <h1>Home</h1>
        <p>See active deployments and projects that need attention.</p>
        <div className="dg-home-actions"><Link className="dg-home-secondary" to="/projects">All projects</Link>{role !== "readonly" ? <Link className="button dg-home-primary" to="/projects/new"><AppIcon name="plus" size={16} />Create project</Link> : null}</div>
      </div>
      {!loading && summaries.length ? <>
        <FleetGauge attention={view.attention.length} deploying={view.active.length} live={liveCount} total={total} />
        <section className="dg-home-kpis" aria-label="Workspace summary">
          <div className="is-total"><span>Total projects</span><strong>{total}</strong><small>In this workspace</small></div>
          <div className={liveCount ? "is-live" : ""}><span>Live</span><strong>{liveCount}</strong><small>Verified stable release</small></div>
          <div className={view.active.length ? "is-deploying" : ""}><span>Deploying</span><strong>{view.active.length}</strong><small>Queued or running</small></div>
          <div className={view.attention.length ? "is-attention" : ""}><span>Needs attention</span><strong>{view.attention.length}</strong><small>Failed or blocked</small></div>
        </section>
      </> : null}
    </section>
    {error ? <ErrorState message={error} /> : null}{loading ? <LoadingState message="Loading workspace…" /> : null}
    {!loading && !summaries.length && !error ? <section className="dg-home-empty"><span className="dg-home-empty-mark"><AppIcon name="github" size={24} /></span><div><h2>Create your first project</h2><p>Connect a GitHub repository and configure the application before deployment.</p></div>{role !== "readonly" ? <Link className="button dg-home-primary" to="/projects/new">Create Project</Link> : null}</section> : null}
    {!loading && summaries.length ? <>
      <section aria-labelledby="home-fleet" className="dg-home-fleet">
        <header><p className="dg-home-kicker" id="home-fleet">Fleet</p><span className="dg-home-fleet-legend" aria-hidden="true"><i className="is-live" />Live<i className="is-deploying" />Deploying<i className="is-failed" />Failed<i className="is-blocked" />Blocked<i className="is-idle" />Other</span></header>
        <ul>{summaries.map(({ project, currentState }) => { const presentation = projectStatePresentation(currentState); return <li className={`dg-home-tile is-${presentation.state.toLowerCase()}`} key={project.id}><Link to={`/projects/${project.id}`}>
          <span aria-hidden="true" className="dg-home-tile-light" />
          <strong>{project.name}</strong>
          <small>{currentState?.repository || project.repositoryFullName}</small>
          <StatusBadge status={presentation.state} tone={projectStateTone(presentation.state)}>{presentation.state.charAt(0) + presentation.state.slice(1).toLowerCase()}</StatusBadge>
        </Link></li>; })}</ul>
      </section>
      {!view.hasDeploymentEvidence ? <section className="dg-home-notice" data-dashboard-empty-deployments="true"><AppIcon name="box" size={16} /><div><strong>No deployment attempts yet</strong><p>These projects contain repository readiness information, but no deployment run or stable release has been recorded.</p></div></section> : null}
      <div className="dg-home-grid">
        <div className="dg-home-main">
          <section aria-labelledby="home-attention" className="dg-home-panel">
            <header><div><p className="dg-home-kicker">Needs attention</p><h2 id="home-attention">Projects requiring action</h2></div><span className={view.attention.length ? "dg-home-count is-danger" : "dg-home-count"}>{view.attention.length}</span></header>
            <ul className="dg-home-rows">{view.attention.map(({ project, currentState }) => <li className="dg-home-row is-attention" key={project.id}>
              <span aria-hidden="true" className="dg-home-row-mark" />
              <span className="dg-home-row-identity"><strong>{project.name}</strong><small>{conciseProjectSummary(currentState)}</small></span>
              <StatusBadge status={currentState?.developerState || "platform_attention"} />
              <Link className="dg-home-row-action" to={`/projects/${project.id}`}>Open project</Link>
            </li>)}</ul>
            {!view.attention.length ? <p className="dg-home-empty-line"><AppIcon name="check" size={15} />No projects need attention.</p> : null}
          </section>
          <section aria-labelledby="home-active" className="dg-home-panel">
            <header><div><p className="dg-home-kicker">Deployments</p><h2 id="home-active">Active deployments</h2></div><span className={view.active.length ? "dg-home-count is-active" : "dg-home-count"}>{view.active.length}</span></header>
            <ul className="dg-home-rows">{view.active.map(({ project, currentState }) => { const release = normalReleaseView(currentState); return <li className="dg-home-row is-active" data-workspace-release={currentState.developerState} key={project.id}>
              <span aria-hidden="true" className="dg-home-row-pulse" />
              <span className="dg-home-row-identity"><strong>{project.name}</strong><small>{currentState.progress?.label || "Preparing"}</small></span>
              <StatusBadge status={currentState.developerState} />
              <span className="dg-home-progress"><span><i style={{ width: `${release?.progress ?? 0}%` }} /></span><small>{release?.progress ?? 0}%</small></span>
              <Link className="dg-home-row-action" to={`/projects/${project.id}/pipeline`}>Open <AppIcon name="arrow" size={14} /></Link>
            </li>; })}</ul>
            {!view.active.length ? <p className="dg-home-empty-line"><strong>No active deployments.</strong> Queued and running deployments will appear here.</p> : null}
          </section>
        </div>
        {workspace.recentlyViewed?.length ? <aside aria-labelledby="home-recent" className="dg-home-recent">
          <header><div><p className="dg-home-kicker">Recent activity</p><h2 id="home-recent">Recently used projects</h2></div></header>
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

/** Fleet gauge: one ring, arcs sized by each state's share of the workspace. */
function FleetGauge({ attention, deploying, live, total }) {
  const radius = 76;
  const circumference = 2 * Math.PI * radius;
  const base = Math.max(1, total, live + deploying + attention);
  let offset = 0;
  const arcs = [["live", live], ["deploying", deploying], ["attention", attention]].filter(([, count]) => count > 0).map(([key, count]) => {
    const length = (count / base) * circumference;
    const arc = { key, dash: `${Math.max(0, length - 4)} ${circumference}`, offset: -offset };
    offset += length;
    return arc;
  });
  return <figure aria-label={`${live} of ${total} projects live`} className="dg-home-gauge">
    <svg aria-hidden="true" viewBox="0 0 200 200">
      <defs><radialGradient id="dg-home-core" cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="rgba(139,92,246,.34)" /><stop offset="100%" stopColor="rgba(34,211,238,0)" /></radialGradient></defs>
      <circle cx="100" cy="100" fill="url(#dg-home-core)" r="98" />
      <circle className="dg-home-gauge-ticks" cx="100" cy="100" r="92" />
      <circle className="dg-home-gauge-track" cx="100" cy="100" r={radius} />
      {arcs.map((arc) => <circle className={`dg-home-gauge-arc is-${arc.key}`} cx="100" cy="100" key={arc.key} r={radius} strokeDasharray={arc.dash} strokeDashoffset={arc.offset} transform="rotate(-90 100 100)" />)}
    </svg>
    <figcaption><strong>{live}<span>/{total}</span></strong><small>live</small></figcaption>
  </figure>;
}
