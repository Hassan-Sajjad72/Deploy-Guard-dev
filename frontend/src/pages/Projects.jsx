import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getWorkspaceSummary } from "../api/projectApi.js";
import AppIcon from "../components/common/AppIcon.jsx";
import { Card, StatusChip } from "../components/common/DesignSystem.jsx";
import EmptyState from "../components/common/EmptyState.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { useAuth } from "../hooks/useAuth.js";
import { formatRelativeTime } from "../utils/time.js";
import { projectStatePresentation } from "../utils/projectStatePresentation.js";

const filters = [
  ["ALL", "All"],
  ["DEPLOYING", "Deploying"],
  ["LIVE", "Live"],
  ["FAILED", "Failed"],
  ["DESTROYED", "Destroyed"],
];

export default function Projects() {
  const { role } = useAuth();
  const [summaries, setSummaries] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [stateFilter, setStateFilter] = useState("ALL");
  const [search, setSearch] = useState("");

  useEffect(() => {
    const load = () => getWorkspaceSummary()
      .then((response) => setSummaries(response.summaries || []))
      .catch((caught) => setError(caught.message))
      .finally(() => setLoading(false));
    void load();
    const onVisible = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const projects = useMemo(
    () => summaries.filter(({ project, currentState }) => {
      const matchesState = stateFilter === "ALL" || projectStatePresentation(currentState).state === stateFilter;
      const haystack = `${project.name} ${currentState?.repository || project.repositoryFullName || ""} ${currentState?.branch || project.targetBranch || ""}`.toLowerCase();
      return matchesState && haystack.includes(search.trim().toLowerCase());
    }),
    [search, stateFilter, summaries]
  );

  return <div className="workspace-page simple-projects-page">
    <header className="workspace-heading">
      <div><p className="eyebrow">Workspace</p><h1>Projects</h1><p>Projects deployed or managed through DeployGuard.</p></div>
      {role !== "readonly" ? <Link className="button" to="/deploy"><AppIcon name="plus" size={16} />Deploy new project</Link> : null}
    </header>
    {error ? <ErrorState message={error} /> : null}
    {loading ? <LoadingState message="Loading projects…" /> : null}
    {!loading && !error && !summaries.length ? <EmptyState action={role !== "readonly" ? <Link className="button" to="/deploy">Deploy a repository</Link> : null} message="Create a project to start managing a repository." title="No projects yet" /> : null}
    {!loading && !error && summaries.length ? <section className="projects-card-section" aria-label="Project inventory">
      <label className="project-search"><span className="sr-only">Search projects</span><AppIcon name="search" size={16} /><input onChange={(event) => setSearch(event.target.value)} placeholder="Search projects, repositories, or branches" type="search" value={search} /></label>
      <div className="project-card-filters" aria-label="Project state filters">
        {filters.map(([value, label]) => <button aria-pressed={stateFilter === value} className={stateFilter === value ? "button" : "secondary-button"} key={value} onClick={() => setStateFilter(value)} type="button">{label}</button>)}
      </div>
      {!projects.length ? <EmptyState message="No deployment attempts match this state." title="No matching projects" /> : <div className="project-card-grid">
        {projects.map(({ project, currentState }) => {
          const presentation = projectStatePresentation(currentState);
          const activity = project.activity?.lastMeaningfulActivityAt || currentState?.latestAttempt?.occurredAt || project.createdAt;
          return <Card className="project-summary-card" data-authoritative-state={presentation.state} key={project.id}>
            <div className="project-card-heading"><div className="project-list-identity"><span className="project-glyph"><AppIcon name="box" size={17} /></span><div><Link title={project.name} to={`/projects/${project.id}`}><h2>{project.name}</h2></Link><p title={currentState?.repository || project.repositoryFullName}>{currentState?.repository || project.repositoryFullName}</p><small>{currentState?.branch || project.targetBranch || "Branch unavailable"}</small></div></div><StatusChip status={presentation.state} /></div>
            <div className="project-card-facts"><article><span>Services</span><strong>{project.services?.length ?? "—"}</strong></article><article><span>Latest deployment</span><strong>{currentState?.latestAttempt ? `Attempt ${currentState.latestAttempt.attempt || "—"}` : "Not started"}</strong></article><article><span>Last activity</span><strong title={activity || "Unavailable"}>{formatRelativeTime(activity)}</strong></article></div>
            <Link aria-label={`Open ${project.name}`} className="secondary-button project-card-action" to={`/projects/${project.id}`}>Open project <AppIcon name="arrow" size={16} /></Link>
          </Card>;
        })}
      </div>}
    </section> : null}
  </div>;
}
