import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getGithubActionsDeploymentHistory, getProject, getProjectCurrentState } from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import PipelineExecution from "../components/projects/PipelineExecution.jsx";
import { redirectDeletedProject, subscribeProjectStateChanged } from "../utils/projectStateSync.js";
import { projectStatePresentation } from "../utils/projectStatePresentation.js";
import { useSerializedProjectRefresh } from "../hooks/useSerializedProjectRefresh.js";
import { PageHeader } from "../components/common/DesignSystem.jsx";

export default function ProjectPipeline() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState(null);
  const [currentState, setCurrentState] = useState(null);
  const [operations, setOperations] = useState([]);
  const [error, setError] = useState("");

  const load = useSerializedProjectRefresh(projectId, useCallback(async (requestedProjectId, isCurrent) => {
    try {
      const [projectResponse, current, history] = await Promise.all([
        getProject(requestedProjectId),
        getProjectCurrentState(requestedProjectId),
        getGithubActionsDeploymentHistory(requestedProjectId),
      ]);
      if (!isCurrent()) return;
      setProject(projectResponse.project);
      setCurrentState(current);
      setOperations(history.operations || []);
      setError("");
    } catch (caught) {
      if (!isCurrent()) return;
      if (redirectDeletedProject(caught, navigate)) return;
      setError(caught.message);
    }
  }, [navigate]));

  useEffect(() => { void load(); }, [load, projectId]);
  useEffect(() => subscribeProjectStateChanged(projectId, load), [load, projectId]);
  useEffect(() => {
    if (!projectStatePresentation(currentState).active) return undefined;
    const timer = window.setInterval(load, 4000);
    return () => window.clearInterval(timer);
  }, [currentState?.stateAuthority?.activeOperation?.id, currentState?.stateAuthority?.activeOperation?.status, load, projectId]);

  if (!project || !currentState) {
    return error ? <div className="page"><ErrorState message={error} onRetry={load} title="Deployments could not be loaded" /></div> : <LoadingState message="Loading deployments…" />;
  }

  const state = projectStatePresentation(currentState);
  return <div className="page deployments-page" data-authoritative-state={state.state}>
    <PageHeader description="Every deploy, rollback and destroy for this project, with its stages and logs." title="Deployments" />
    {error ? <ErrorState message={error} onRetry={load} title="Showing the last loaded history" /> : null}
    <PipelineExecution currentState={currentState} operations={operations} projectId={projectId} />
  </div>;
}
