import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { getWorkspaceSummary } from "../api/projectApi.js";
import AppIcon from "../components/common/AppIcon.jsx";
import { StatusChip } from "../components/common/DesignSystem.jsx";
import EmptyState from "../components/common/EmptyState.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { useAuth } from "../hooks/useAuth.js";
import { formatRelativeTime } from "../utils/time.js";
import { projectStatePresentation, projectStateTone } from "../utils/projectStatePresentation.js";

const filters = [
  ["ALL", "All"],
  ["DEPLOYING", "Deploying"],
  ["LIVE", "Live"],
  ["FAILED", "Failed"],
  ["DESTROYED", "Destroyed"],
];

export default function Projects() {
  const { role } = useAuth();
  const location = useLocation();
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

  const counts = useMemo(() => summaries.reduce((totals, { currentState }) => {
    const state = projectStatePresentation(currentState).state;
    return { ...totals, [state]: (totals[state] || 0) + 1 };
  }, { ALL: summaries.length }), [summaries]);

  const liveCount = counts.LIVE || 0;
  const attentionCount = (counts.FAILED || 0) + (counts.BLOCKED || 0);
  return <div className="workspace-page simple-projects-page dg-projects">
    <header className="dg-projects-head">
      <div className="dg-projects-title"><h1>Projects</h1><p>Projects deployed or managed through DeployGuard.</p>{!loading && summaries.length ? <p className="dg-projects-summary">{summaries.length} projects · {liveCount} live · {attentionCount} need attention</p> : null}</div>
      {role !== "readonly" ? <Link className="button dg-projects-primary" to="/deploy"><AppIcon name="plus" size={16} />Deploy new project</Link> : null}
    </header>
    {location.state?.notice ? <p className="state success" role="status">{location.state.notice}</p> : null}
    {error ? <ErrorState message={error} /> : null}
    {loading ? <LoadingState message="Loading projects…" /> : null}
    {!loading && !error && !summaries.length ? <EmptyState action={role !== "readonly" ? <Link className="button" to="/deploy">Deploy a repository</Link> : null} message="Create a project to start managing a repository." title="No projects yet" /> : null}
    {!loading && !error && summaries.length ? <section className="dg-projects-inventory" aria-label="Project inventory">
      <div className="dg-projects-toolbar">
        <label className="dg-projects-search"><span className="sr-only">Search projects</span><AppIcon name="search" size={16} /><input onChange={(event) => setSearch(event.target.value)} placeholder="Search projects, repositories, or branches" type="search" value={search} /></label>
        <div className="dg-projects-filters" aria-label="Project state filters">
          {filters.map(([value, label]) => <button aria-pressed={stateFilter === value} className={stateFilter === value ? "is-active" : ""} key={value} onClick={() => setStateFilter(value)} type="button">{label}<span>{counts[value] || 0}</span></button>)}
        </div>
      </div>
      {!projects.length ? <EmptyState message="No deployment attempts match this state." title="No matching projects" /> : <div className="project-inventory-list" role="list">
        <div aria-hidden="true" className="dg-projects-columns"><span>Project</span><span>Status</span><span>Services</span><span>Latest deployment</span><span>Last activity</span><span /></div>
        {projects.map(({ project, currentState }) => {
          const presentation = projectStatePresentation(currentState);
          const activity = project.activity?.lastMeaningfulActivityAt || currentState?.latestAttempt?.occurredAt || project.createdAt;
          const repository = currentState?.repository || project.repositoryFullName;
          return <article className="dg-projects-row" data-authoritative-state={presentation.state} key={project.id} role="listitem">
            <div className="dg-projects-identity"><span aria-hidden="true" className="dg-projects-glyph">{String(project.name || "?").charAt(0).toUpperCase()}</span><div><Link title={project.name} to={`/projects/${project.id}`}><h2>{project.name}</h2></Link><p><span className="dg-projects-repo" title={repository}><AppIcon name="github" size={13} />{repository}</span>{currentState?.branch || project.targetBranch ? <span className="dg-projects-branch"><AppIcon name="branch" size={13} />{currentState?.branch || project.targetBranch}</span> : null}</p></div></div>
            <div className="dg-projects-cell dg-projects-status"><StatusChip status={presentation.state} tone={projectStateTone(presentation.state)} /></div>
            <div className="dg-projects-cell"><span className="dg-projects-label">Services</span><strong>{project.services?.length ?? "—"}</strong></div>
            <div className="dg-projects-cell"><span className="dg-projects-label">Latest deployment</span><strong>{currentState?.latestAttempt ? `Attempt ${currentState.latestAttempt.attempt || "—"}` : "—"}</strong></div>
            <div className="dg-projects-cell"><span className="dg-projects-label">Last activity</span><strong title={activity || undefined}>{activity ? formatRelativeTime(activity) : "—"}</strong></div>
            <Link aria-label={`Open ${project.name}`} className="dg-projects-open" to={`/projects/${project.id}`}>Open <AppIcon name="arrow" size={15} /></Link>
          </article>;
        })}
      </div>}
    </section> : null}
  </div>;
}
