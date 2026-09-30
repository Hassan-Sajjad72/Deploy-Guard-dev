import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getGithubActionsDeploymentHistory, getProject, getProjectCurrentState } from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { StatusChip } from "../components/common/DesignSystem.jsx";
import AppIcon from "../components/common/AppIcon.jsx";
import PipelineExecution from "../components/projects/PipelineExecution.jsx";
import PipelineRecoveryPanel from "../components/projects/PipelineRecoveryPanel.jsx";
import { redirectDeletedProject, subscribeProjectStateChanged } from "../utils/projectStateSync.js";
import { projectStatePresentation, projectStateTone } from "../utils/projectStatePresentation.js";
import { useSerializedProjectRefresh } from "../hooks/useSerializedProjectRefresh.js";

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
    return <div className="workspace-page">{error ? <ErrorState message={error} onRetry={load} /> : <LoadingState message="Loading deployments…" />}</div>;
  }

  const state = projectStatePresentation(currentState);
  const release = currentState.stableRelease?.commit ? currentState.stableRelease.commit.slice(0, 12) : null;
  return <div className="workspace-page project-pipeline-page dg-pipeline" data-authoritative-state={state.state}>
    <header className="dg-pl-head">
      <div><p className="dg-pl-kicker">Deployments · {project.name}</p><div className="dg-pl-title-row"><h1>Deployment pipeline</h1><StatusChip status={state.state} tone={projectStateTone(state.state)} /></div></div>
      <p className="dg-pl-context">
        {project.environmentName ? <span>Environment {project.environmentName}</span> : null}
        <span><AppIcon name="github" size={13} />{currentState.repository || project.repositoryFullName}</span>
        <span className="is-mono"><AppIcon name="branch" size={13} />{currentState.branch || project.targetBranch}</span>
        {release ? <span className="is-mono">Release {release}</span> : null}
      </p>
    </header>
    {error ? <ErrorState message={error} onRetry={load} /> : null}
    <PipelineExecution canManage={Boolean(project.canManage)} currentState={currentState} onRefresh={load} operations={operations} projectId={projectId} />
    <PipelineRecoveryPanel operations={operations} />
  </div>;
}
