import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getGithubActionsDeploymentHistory, getProject, getProjectCurrentState } from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { PageHeader } from "../components/common/DesignSystem.jsx";
import PipelineExecution from "../components/projects/PipelineExecution.jsx";
import PipelineRecoveryPanel from "../components/projects/PipelineRecoveryPanel.jsx";
import { subscribeProjectStateChanged } from "../utils/projectStateSync.js";
import { projectStatePresentation } from "../utils/projectStatePresentation.js";
import { useSerializedProjectRefresh } from "../hooks/useSerializedProjectRefresh.js";

export default function ProjectPipeline() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState(null);
  const [currentState, setCurrentState] = useState(null);
  const [operations, setOperations] = useState([]);
  const [recoveryRefreshVersion, setRecoveryRefreshVersion] = useState(0);
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
      setRecoveryRefreshVersion((version) => version + 1);
      setError("");
    } catch (caught) {
      if (!isCurrent()) return;
      if (caught.status === 404) { navigate("/projects", { replace: true, state: { notice: "Project deletion completed." } }); return; }
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
    return <div className="workspace-page">{error ? <ErrorState message={error} onRetry={load} /> : <LoadingState message="Loading deployments…" />}</div>;
  }

  const state = projectStatePresentation(currentState);
  return <div className="workspace-page project-pipeline-page" data-authoritative-state={state.state}>
    <PageHeader context={`${currentState.repository || project.repositoryFullName} · ${currentState.branch || project.targetBranch}`} eyebrow="Deployments" status={state.state} title="Deployment pipeline" />
    {error ? <ErrorState message={error} onRetry={load} /> : null}
    <PipelineExecution canManage={Boolean(project.canManage)} currentState={currentState} onRefresh={load} operations={operations} projectId={projectId} />
    <PipelineRecoveryPanel operations={operations} projectId={projectId} refreshVersion={recoveryRefreshVersion} />
  </div>;
}
