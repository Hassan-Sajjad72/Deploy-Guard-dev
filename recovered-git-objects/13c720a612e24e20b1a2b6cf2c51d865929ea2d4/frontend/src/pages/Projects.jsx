import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getWorkspaceSummary } from "../api/projectApi.js";
import AppIcon from "../components/common/AppIcon.jsx";
import EmptyState from "../components/common/EmptyState.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { StatusBadge } from "../components/common/Premium.jsx";
import { useAuth } from "../hooks/useAuth.js";

function human(value) { return String(value || "unknown").replaceAll("_", " "); }
function deploymentLabel(state) { return state?.deploymentStatus ? human(state.deploymentStatus) : "Unknown"; }
function actionLabel(state) { return state?.nextAction?.label || human(state?.cloudNextAction || "no_action"); }

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
    {!loading && summaries.length ? <section className="projects-list-panel panel-flat"><div className="project-trust-table"><div className="project-trust-head"><span>Project</span><span>Deployment</span><span>Health</span><span>Resources</span><span>Next action</span><span /></div>{summaries.map(({ project, currentState }) => <article className="project-trust-row" key={project.id}><span className="project-list-identity"><span className="project-glyph"><AppIcon name="box" size={17} /></span><span><strong>{project.name}</strong><small>{project.repositoryFullName} · {project.targetBranch || "—"}</small></span></span><StatusBadge status={currentState?.deploymentStatus || "unknown"}>{deploymentLabel(currentState)}</StatusBadge><span className="trust-cell"><strong>{human(currentState?.healthStatus)}</strong><small>{currentState?.cloudVerificationStatus === "verified" ? "Cloud verified" : human(currentState?.cloudVerificationStatus)}</small></span><span className="trust-cell"><strong>{human(currentState?.resourceStatus)}</strong><small>{currentState?.adminActionRequired ? "Admin action required" : human(currentState?.inventoryStatus)}</small></span><span className="trust-cell"><strong>{actionLabel(currentState)}</strong><small>{currentState?.statusExplanation || "Status unavailable"}</small></span><Link className="secondary-button compact-button" to={`/projects/${project.id}`}>Open</Link></article>)}</div></section> : null}
  </div>;
}
