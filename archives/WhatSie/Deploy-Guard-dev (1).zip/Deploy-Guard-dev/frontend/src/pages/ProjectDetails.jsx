import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getProject } from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import PreflightPanel from "../components/projects/PreflightPanel.jsx";
import StackDetectionPanel from "../components/projects/StackDetectionPanel.jsx";

function formatDate(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value)) : "-";
}

export default function ProjectDetails() {
  const { projectId } = useParams();
  const [project, setProject] = useState(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadProject() {
      setError("");
      setIsLoading(true);

      try {
        const response = await getProject(projectId);
        setProject(response.project);
      } catch (caughtError) {
        setError(caughtError.message);
      } finally {
        setIsLoading(false);
      }
    }

    loadProject();
  }, [projectId]);

  if (isLoading) {
    return <LoadingState message="Loading project..." />;
  }

  if (error) {
    return <ErrorState message={error} />;
  }

  return (
    <div className="grid">
      <div className="page-header">
        <div>
          <h1>{project.name}</h1>
          <p className="muted">{project.description || "No description"}</p>
        </div>
        <div className="quick-actions">
          <Link className="secondary-button" to={`/projects/${project.id}/settings`}>
            Settings
          </Link>
          <Link className="secondary-button" to={`/projects/${project.id}/env`}>
            Environment Variables
          </Link>
          <Link className="secondary-button" to={`/projects/${project.id}/preflight`}>
            Pre-Flight
          </Link>
          <Link className="secondary-button" to={`/projects/${project.id}/pipeline`}>
            CI/CD Pipeline
          </Link>
          <Link className="secondary-button" to={`/projects/${project.id}/security`}>
            Security Scans
          </Link>
          <Link
            className="secondary-button"
            to={`/audit-logs?resourceType=project&resourceId=${project.id}`}
          >
            Audit Logs
          </Link>
        </div>
      </div>

      <section className="panel">
        <dl className="details-list">
          <dt>Repository URL</dt>
          <dd>{project.repositoryUrl}</dd>
          <dt>Repository</dt>
          <dd>{project.repositoryFullName || "-"}</dd>
          <dt>Target branch</dt>
          <dd>{project.targetBranch}</dd>
          <dt>Status</dt>
          <dd>{project.status}</dd>
          <dt>Visibility</dt>
          <dd>{project.visibility}</dd>
          <dt>Created</dt>
          <dd>{formatDate(project.createdAt)}</dd>
        </dl>
      </section>

      <StackDetectionPanel canManage={project.canManage} projectId={project.id} />
      <PreflightPanel canManage={project.canManage} projectId={project.id} />
    </div>
  );
}
