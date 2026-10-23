import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getProjects } from "../api/projectApi.js";
import EmptyState from "../components/common/EmptyState.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import ProjectTable from "../components/projects/ProjectTable.jsx";
import { useAuth } from "../hooks/useAuth.js";

export default function Projects() {
  const { role } = useAuth();
  const [projects, setProjects] = useState([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const canCreate = role === "admin" || role === "developer";

  useEffect(() => {
    async function loadProjects() {
      setError("");
      setIsLoading(true);

      try {
        const response = await getProjects();
        setProjects(response?.projects || []);
      } catch (caughtError) {
        setError(caughtError.message);
      } finally {
        setIsLoading(false);
      }
    }

    loadProjects();
  }, []);

  return (
    <div className="grid">
      <div className="page-header">
        <div>
          <h1>Projects</h1>
          <p className="muted">Manage application workspaces and repository links.</p>
        </div>
        {canCreate ? (
          <Link className="button" to="/projects/new">
            Create Project
          </Link>
        ) : null}
      </div>

      {error ? <ErrorState message={error} /> : null}
      {isLoading ? <LoadingState message="Loading projects..." /> : null}
      {!isLoading && !error && projects.length === 0 ? (
        <EmptyState message="No projects found." />
      ) : null}
      {!isLoading && projects.length > 0 ? (
        <ProjectTable projects={projects} />
      ) : null}
    </div>
  );
}
