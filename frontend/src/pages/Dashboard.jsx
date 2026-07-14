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
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => { getWorkspaceSummary().then((response) => setSummaries(response.summaries || [])).catch((caught) => setError(caught.message)).finally(() => setLoading(false)); }, []);
  const view = useMemo(() => {
    const active = summaries.filter(({ currentState }) => ["queued", "running"].includes(currentState?.latestPipeline?.status));
    const attention = summaries.filter(({ currentState }) => ["failed", "blocked", "paused"].includes(currentState?.overallStatus));
    const live = summaries.filter(({ currentState }) => currentState?.liveDeployment?.available);
    const next = active[0] || attention[0] || summaries[0] || null;
    return { active, attention, live, next };
  }, [summaries]);
  return <div className="workspace-page simple-dashboard-page">
    <header className="workspace-heading"><div><p className="eyebrow">Workspace</p><h1>Deployments</h1><p>Your deployment status at a glance.</p></div>{role !== "readonly" ? <Link className="button" to="/projects/new"><AppIcon name="plus" size={16} />New deployment</Link> : null}</header>
    {error ? <ErrorState message={error} /> : null}{loading ? <LoadingState message="Loading deployments…" /> : null}
    {!loading && !summaries.length && !error ? <section className="workspace-empty-state"><div className="empty-orbit"><AppIcon name="github" size={28} /></div><h2>Deploy your first repository</h2><p>Select a GitHub repository and DeployGuard will prepare it automatically.</p>{role !== "readonly" ? <Link className="button" to="/projects/new">Choose repository</Link> : null}</section> : null}
    {!loading && summaries.length ? <>
      <section className="simple-dashboard-summary" aria-label="Deployment summary"><span><strong>{view.active.length}</strong> Active</span><span className={view.live.length ? "text-success" : ""}><strong>{view.live.length}</strong> Live</span><span className={view.attention.length ? "text-danger" : ""}><strong>{view.attention.length}</strong> Needs attention</span></section>
      {view.next ? <section className="continue-deployment-card"><div className="deployment-card-top"><span className="project-glyph"><AppIcon name="box" size={18} /></span><StatusBadge status={view.next.currentState?.overallStatus || "unknown"} /></div><div><p className="eyebrow">Continue</p><h2>{view.next.project.name}</h2><p>{view.next.currentState?.userFacingStatus || "Open the project to continue its deployment."}</p></div><div className="continue-progress"><div><span>{view.next.currentState?.currentStepLabel || "Ready"}</span><strong>{view.next.currentState?.progressPercentage || 0}%</strong></div><div className="progress-track"><span style={{ width: `${view.next.currentState?.progressPercentage || 0}%` }} /></div></div><Link className="button" to={`/projects/${view.next.project.id}`}>Open project <AppIcon name="arrow" size={15} /></Link></section> : null}
    </> : null}
  </div>;
}
