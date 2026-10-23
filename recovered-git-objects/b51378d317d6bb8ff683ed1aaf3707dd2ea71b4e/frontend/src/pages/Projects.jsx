import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getWorkspaceSummary } from "../api/projectApi.js";
import AppIcon from "../components/common/AppIcon.jsx";
import EmptyState from "../components/common/EmptyState.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { StatusBadge } from "../components/common/Premium.jsx";
import { useAuth } from "../hooks/useAuth.js";
import { formatRelativeTime } from "../utils/time.js";

function human(value) { return String(value || "unknown").replaceAll("_", " "); }

export default function Projects() {
  const { role } = useAuth();
  const [summaries, setSummaries] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState("workspace");
  useEffect(() => { getWorkspaceSummary().then((response) => setSummaries(response.summaries || [])).catch((caught) => setError(caught.message)).finally(() => setLoading(false)); }, []);
  const ordered = useMemo(() => [...summaries].sort((left, right) => {
    if (sort === "workspace") return 0;
    if (sort === "viewed") return new Date(right.project.activity?.lastViewedAt || 0) - new Date(left.project.activity?.lastViewedAt || 0);
    if (sort === "created") return new Date(right.project.createdAt) - new Date(left.project.createdAt);
    if (sort === "name") return left.project.name.localeCompare(right.project.name);
    if (sort === "status") return String(left.currentState?.developerState).localeCompare(String(right.currentState?.developerState));
    return new Date(right.project.activity?.lastMeaningfulActivityAt || right.project.createdAt) - new Date(left.project.activity?.lastMeaningfulActivityAt || left.project.createdAt);
  }), [summaries, sort]);
  return <div className="workspace-page simple-projects-page">
    <header className="workspace-heading"><div><p className="eyebrow">Workspace</p><h1>Projects</h1><p>Every repository connected to DeployGuard.</p></div>{role !== "readonly" ? <Link className="button" to="/projects/new"><AppIcon name="plus" size={16} />New deployment</Link> : null}</header>
    {error ? <ErrorState message={error} /> : null}{loading ? <LoadingState message="Loading projects…" /> : null}
    {!loading && !error && !summaries.length ? <EmptyState message="No projects yet. Choose a GitHub repository to create the first one." /> : null}
    {!loading && summaries.length ? <section className="projects-list-panel panel-flat"><div className="compact-section-heading"><div><p className="eyebrow">Ordering</p><h2>Project workspaces</h2></div><label className="field compact-field"><span>Sort</span><select value={sort} onChange={(event) => setSort(event.target.value)}><option value="workspace">Active and needs attention</option><option value="meaningful">Last meaningful activity</option><option value="viewed">Recently viewed</option><option value="created">Created date</option><option value="name">Name</option><option value="status">Status</option></select></label></div><div className="project-trust-table project-recency-table"><div className="project-trust-head"><span>Project</span><span>Status</span><span>Last meaningful activity</span><span>Next action</span><span /></div>{ordered.map(({ project, currentState }) => <article className="project-trust-row" key={project.id}><span className="project-list-identity"><span className="project-glyph"><AppIcon name="box" size={17} /></span><span><strong>{project.name}</strong><small>{currentState?.repository || project.repositoryFullName} · {currentState?.branch || project.targetBranch || "—"}</small></span></span><StatusBadge status={currentState?.developerState || "unknown"}>{human(currentState?.developerState)}</StatusBadge><span className="trust-cell"><strong>{formatRelativeTime(project.activity?.lastMeaningfulActivityAt || project.createdAt)}</strong><small>{currentState?.developerMessage}</small></span><span className="trust-cell"><strong>{human(currentState?.developerAction || "none")}</strong></span><Link className="secondary-button compact-button" to={`/projects/${project.id}`}>Continue</Link></article>)}</div></section> : null}
  </div>;
}
