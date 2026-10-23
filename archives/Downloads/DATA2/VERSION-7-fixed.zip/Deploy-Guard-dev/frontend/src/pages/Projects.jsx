import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getProjectCurrentState, getProjects } from "../api/projectApi.js";
import EmptyState from "../components/common/EmptyState.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { PageHeader } from "../components/common/Premium.jsx";
import ProjectWorkspaceCard from "../components/projects/ProjectWorkspaceCard.jsx";
import { useAuth } from "../hooks/useAuth.js";

const filters = ["all", "needs setup", "active", "failed", "blocked", "live"];

function matchesFilter(summary, filter) {
  const state = summary.currentState;
  if (filter === "all") return true;
  if (!state) return filter === "needs setup";
  if (filter === "needs setup") return ["setup_required", "ready_for_detection", "ready_for_preflight"].includes(state.overallStatus);
  if (filter === "failed") return state.overallStatus === "failed" || Boolean(state.failedStage);
  if (filter === "blocked") return state.overallStatus === "blocked";
  if (filter === "active") return ["queued", "running"].includes(state.latestPipeline?.status);
  if (filter === "live") return state.liveDeployment?.available;
  return true;
}

export default function Projects() {
  const { role } = useAuth();
  const [summaries, setSummaries] = useState([]);
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState("all");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const canCreate = role === "admin" || role === "developer";

  useEffect(() => {
    async function loadProjects() {
      try {
        const response = await getProjects();
        const projects = response.projects || [];
        const states = await Promise.allSettled(projects.map((project) => getProjectCurrentState(project.id)));
        setSummaries(projects.map((project, index) => ({ project, currentState: states[index].status === "fulfilled" ? states[index].value : null })));
      } catch (caughtError) {
        setError(caughtError.message);
      } finally {
        setIsLoading(false);
      }
    }
    loadProjects();
  }, []);

  const visible = useMemo(() => summaries.filter((summary) => {
    const search = query.trim().toLowerCase();
    const matchesSearch = !search || [summary.project.name, summary.project.repositoryFullName, summary.project.repositoryUrl, summary.project.targetBranch].some((value) => String(value || "").toLowerCase().includes(search));
    return matchesSearch && matchesFilter(summary, activeFilter);
  }), [activeFilter, query, summaries]);

  return (
    <div className="grid">
      <PageHeader eyebrow="Projects" title="Application Workspaces" description="Find the workspace that needs attention and continue from its recommended release action." actions={canCreate ? <Link className="button" to="/projects/new">Create Workspace</Link> : null} />

      <section className="panel project-discovery-bar">
        <label className="field project-search"><span>Search projects</span><input onChange={(event) => setQuery(event.target.value)} placeholder="Search by project, repository, or branch" type="search" value={query} /></label>
        <div className="filter-pills" aria-label="Project status filters">{filters.map((filter) => <button className={filter === activeFilter ? "filter-pill active" : "filter-pill"} key={filter} onClick={() => setActiveFilter(filter)} type="button">{filter}</button>)}</div>
      </section>

      {error ? <ErrorState message={error} /> : null}
      {isLoading ? <LoadingState message="Loading project workspaces..." /> : null}
      {!isLoading && !error && !summaries.length ? <EmptyState message="No projects exist yet. Create a workspace to connect a repository and begin stack detection." /> : null}
      {!isLoading && summaries.length && !visible.length ? <EmptyState message="No projects match this search and status filter." /> : null}
      {!isLoading && visible.length ? <div className="workspace-grid">{visible.map(({ project, currentState }) => <ProjectWorkspaceCard currentState={currentState} key={project.id} project={project} />)}</div> : null}
    </div>
  );
}
