import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getProject, getProjectCurrentState } from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { PageHeader } from "../components/common/DesignSystem.jsx";
import ProjectOverviewLifecycle from "../components/projects/ProjectOverviewLifecycle.jsx";
import NotificationSettingsPanel from "../components/projects/NotificationSettingsPanel.jsx";
import { subscribeProjectStateChanged } from "../utils/projectStateSync.js";
import { projectStatePresentation } from "../utils/projectStatePresentation.js";
import { useSerializedProjectRefresh } from "../hooks/useSerializedProjectRefresh.js";

export default function ProjectDetails() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState(null);
  const [currentState, setCurrentState] = useState(null);
  const [error, setError] = useState("");

  const load = useSerializedProjectRefresh(projectId, useCallback(async (requestedProjectId, isCurrent) => {
    try {
      const [projectResponse, current] = await Promise.all([
        getProject(requestedProjectId),
        getProjectCurrentState(requestedProjectId),
      ]);
      if (!isCurrent()) return;
      setProject(projectResponse.project);
      setCurrentState(current);
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
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [currentState?.stateAuthority?.activeOperation?.id, currentState?.stateAuthority?.activeOperation?.status, load, projectId]);

  if (!project || !currentState) {
    return <div className="workspace-page">{error ? <ErrorState message={error} onRetry={load} /> : <LoadingState message="Loading project…" />}</div>;
  }

  const reconciliation = currentState.stateAuthority?.reconciliation || {};
  const state = projectStatePresentation(currentState);
  const lastUpdated = reconciliation.lastReconciledAt
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(reconciliation.lastReconciledAt))
    : "Unavailable";

  return <div className="workspace-page project-overview-page" data-authoritative-state={projectStatePresentation(currentState).state}>
    <PageHeader context={`${currentState.repository || project.repositoryFullName} · ${currentState.branch || project.targetBranch} · Source: ${reconciliation.source?.replaceAll("_", " ") || "unavailable"} · Last updated: ${lastUpdated} · ${reconciliation.freshness || "unavailable"}`} eyebrow="Project overview" status={state.state} title={project.name} />
    {error ? <ErrorState message={error} onRetry={load} /> : null}
    <ProjectOverviewLifecycle canManage={Boolean(project.canManage)} currentState={currentState} onRefresh={load} projectId={projectId} />
    <NotificationSettingsPanel canManage={Boolean(project.canManage)} projectId={projectId} />
  </div>;
}
