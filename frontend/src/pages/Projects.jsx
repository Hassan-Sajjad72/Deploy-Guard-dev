import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getWorkspaceSummary } from "../api/projectApi.js";
import AppIcon from "../components/common/AppIcon.jsx";
import EmptyState from "../components/common/EmptyState.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { StatusBadge } from "../components/common/Premium.jsx";
import { useAuth } from "../hooks/useAuth.js";

function appStatus(state) {
  if (state?.liveDeployment?.available) return "Live";
  if (["failed", "blocked"].includes(state?.overallStatus)) return "Needs attention";
  if (state?.overallStatus === "paused") return "Paused";
  if (["queued", "running"].includes(state?.latestPipeline?.status)) return "Deploying";
  return state?.currentStepLabel || "Ready";
}

export default function Projects() {
  const { role } = useAuth();
  const [summaries, setSummaries] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => { getWorkspaceSummary().then((response) => setSummaries(response.summaries || [])).catch((caught) => setError(caught.message)).finally(() => setLoading(false)); }, []);
  return <div className="workspace-page simple-projects-page">
    <header className="workspace-heading"><div><p className="eyebrow">Workspace</p><h1>Projects</h1><p>Every repository connected to DeployGuard.</p></div>{role !== "readonly" ? <Link className="button" to="/projects/new"><AppIcon name="plus" size={16} />New deployment</Link> : null}</header>
    {error ? <ErrorState message={error} /> : null}{loading ? <LoadingState message="Loading projects…" /> : null}
    {!loading && !error && !summaries.length ? <EmptyState message="No projects yet. Choose a GitHub repository to create the first one." /> : null}
    {!loading && summaries.length ? <section className="projects-list-panel panel-flat"><div className="simple-project-list">{summaries.map(({ project, currentState }) => <article className="project-list-row" key={project.id}><span className="project-glyph"><AppIcon name="box" size={17} /></span><span className="project-list-identity"><strong>{project.name}</strong><small>{project.repositoryFullName}</small></span><span className="project-list-stage"><small>Branch</small><strong>{project.targetBranch || "—"}</strong></span><span className="simple-project-status"><StatusBadge status={currentState?.overallStatus || "unknown"}>{appStatus(currentState)}</StatusBadge><small>{currentState?.currentStepLabel || "Status unavailable"}</small></span>{currentState?.liveDeployment?.available ? <a className="text-link" href={currentState.liveDeployment.url} onClick={(event) => event.stopPropagation()} rel="noreferrer" target="_blank">Live URL</a> : <span /> }<Link className="secondary-button compact-button" to={`/projects/${project.id}`}>Open</Link></article>)}</div></section> : null}
  </div>;
}
