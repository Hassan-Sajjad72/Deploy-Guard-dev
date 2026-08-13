import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getGithubActionsDeploymentHistory, getProject, getProjectCurrentState } from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { PageHeader } from "../components/common/DesignSystem.jsx";
import PipelineExecution from "../components/projects/PipelineExecution.jsx";
import PipelineRecoveryPanel from "../components/projects/PipelineRecoveryPanel.jsx";
import { subscribeProjectStateChanged } from "../utils/projectStateSync.js";
import { projectStatePresentation } from "../utils/projectStatePresentation.js";

export default function ProjectPipeline() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState(null);
  const [currentState, setCurrentState] = useState(null);
  const [operations, setOperations] = useState([]);
  const [recoveryRefreshVersion, setRecoveryRefreshVersion] = useState(0);
  const [error, setError] = useState("");

  async function load() {
    try {
      const [projectResponse, current, history] = await Promise.all([
        getProject(projectId),
        getProjectCurrentState(projectId),
        getGithubActionsDeploymentHistory(projectId),
      ]);
      setProject(projectResponse.project);
      setCurrentState(current);
      setOperations(history.operations || []);
      setRecoveryRefreshVersion((version) => version + 1);
      setError("");
    } catch (caught) {
      if (caught.status === 404) { navigate("/projects", { replace: true, state: { notice: "Project deletion completed." } }); return; }
      setError(caught.message);
    }
  }

  useEffect(() => { load(); }, [projectId]);
  useEffect(() => subscribeProjectStateChanged(projectId, load), [projectId]);
  useEffect(() => {
    if (!projectStatePresentation(currentState).active) return undefined;
    const timer = window.setInterval(load, 4000);
    return () => window.clearInterval(timer);
  }, [currentState?.developerState, projectId]);

  if (!project || !currentState) {
    return <div className="workspace-page">{error ? <ErrorState message={error} onRetry={load} /> : <LoadingState message="Loading deployments…" />}</div>;
  }

  const reconciliation = currentState.stateAuthority?.reconciliation || {};
  const state = projectStatePresentation(currentState);
  return <div className="workspace-page project-pipeline-page" data-authoritative-state={state.state}>
    <PageHeader context={`${currentState.repository || project.repositoryFullName} · ${currentState.branch || project.targetBranch} · Source: ${reconciliation.source?.replaceAll("_", " ") || "unavailable"} · ${reconciliation.freshness || "unavailable"}`} eyebrow="Pipeline and recovery" status={state.state} title="Deployment pipeline" />
    {error ? <ErrorState message={error} onRetry={load} /> : null}
    <PipelineExecution canManage={Boolean(project.canManage)} currentState={currentState} onRefresh={load} operations={operations} projectId={projectId} />
    <PipelineRecoveryPanel operations={operations} projectId={projectId} refreshVersion={recoveryRefreshVersion} />
  </div>;
}
