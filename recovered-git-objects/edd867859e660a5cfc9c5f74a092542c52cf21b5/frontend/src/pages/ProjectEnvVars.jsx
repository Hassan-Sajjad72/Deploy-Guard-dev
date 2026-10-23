import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { getProject } from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { PageHeader } from "../components/common/Premium.jsx";
import EnvironmentVariablesPanel from "../components/projects/EnvironmentVariablesPanel.jsx";

export default function ProjectEnvVars() {
  const { projectId } = useParams();
  const [searchParams] = useSearchParams();
  const [project, setProject] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    getProject(projectId).then((response) => setProject(response.project)).catch((caught) => setError(caught.message));
  }, [projectId]);

  if (error) return <ErrorState message={error} />;
  if (!project) return <LoadingState message="Loading environment variables…" />;

  return <div className="workspace-page">
    <PageHeader eyebrow="Advanced settings" title="Custom application variables" description="Add optional application configuration in Developer Mode. Managed service aliases and platform configuration are protected." context={`${project.repositoryFullName || project.name} · ${project.targetBranch}`} />
    {searchParams.get("recovery") ? <section className="focused-settings-banner"><div><span>You are fixing</span><strong>Missing environment variables</strong></div><Link className="subtle-button" to={`/projects/${projectId}/settings`}>Show full settings</Link></section> : null}
    <EnvironmentVariablesPanel canManage={project.canManage} projectId={projectId} />
  </div>;
}
