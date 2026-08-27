import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { getProject, getProjectCurrentState } from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { PageHeader } from "../components/common/Premium.jsx";

export default function ProjectRecovery() {
  const { projectId } = useParams();
  const [project, setProject] = useState(null);
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { Promise.all([getProject(projectId), getProjectCurrentState(projectId)]).then(([projectResponse, current]) => { setProject(projectResponse.project); setState(current); }).catch((caught) => setError(caught.message)); }, [projectId]);
  if (error) return <ErrorState message={error} />;
  if (!project || !state) return <LoadingState message="Finding the safest recovery action…" />;
  if (state.developerAction === "provide_configuration") return <Navigate replace to={`/projects/${projectId}/requirements`} />;
  return <div className="workspace-page recovery-center-page">
    <PageHeader eyebrow="Project recovery" title="Fix deployment" description="DeployGuard has reduced the latest failure to one required action." context={`${project.repositoryFullName} · ${project.targetBranch}`} />
    <section className={`panel-flat state ${state.developerState === "platform_attention" ? "warning" : "success"}`}><strong>{state.developerState === "platform_attention" ? "Platform attention" : "No developer recovery action required"}</strong><p>{state.developerMessage}</p><Link className="secondary-button" to={`/projects/${projectId}`}>Back to overview</Link></section>
    <div className="recovery-secondary-actions"><Link className="subtle-button" to={`/projects/${projectId}/pipeline`}>Open pipeline</Link></div>
  </div>;
}
