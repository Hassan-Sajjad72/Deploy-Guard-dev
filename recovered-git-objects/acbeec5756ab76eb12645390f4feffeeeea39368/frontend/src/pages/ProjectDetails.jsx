import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getProject, getProjectCurrentState } from "../api/projectApi.js";
import AppIcon from "../components/common/AppIcon.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import CanonicalDeploymentView from "../components/projects/CanonicalDeploymentView.jsx";
import { subscribeProjectStateChanged } from "../utils/projectStateSync.js";
import { projectStatePresentation } from "../utils/projectStatePresentation.js";

export default function ProjectDetails() {
  const { projectId } = useParams();
  const [project, setProject] = useState(null);
  const [currentState, setCurrentState] = useState(null);
  const [canonicalFetchVersion, setCanonicalFetchVersion] = useState(0);
  const [error, setError] = useState("");

  async function load() {
    try {
      const [projectResponse, current] = await Promise.all([
        getProject(projectId),
        getProjectCurrentState(projectId),
      ]);
      setProject(projectResponse.project);
      setCurrentState(current);
      setCanonicalFetchVersion((version) => version + 1);
      setError("");
    } catch (caught) {
      setError(caught.message);
    }
  }

  useEffect(() => { load(); }, [projectId]);
  useEffect(() => subscribeProjectStateChanged(projectId, load), [projectId]);
  useEffect(() => {
    if (!projectStatePresentation(currentState).active) return undefined;
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [currentState?.developerState, projectId]);

  if (!project || !currentState) {
    return <div className="workspace-page">{error ? <ErrorState message={error} onRetry={load} /> : <LoadingState message="Loading project…" />}</div>;
  }

  return <div className="workspace-page project-overview-page" data-authoritative-state={projectStatePresentation(currentState).state}>
    <header className="project-page-header">
      <div className="project-title-lockup">
        <span className="project-glyph project-glyph-large"><AppIcon name="box" size={21} /></span>
        <div><h1>{project.name}</h1><p>{currentState.repository || project.repositoryFullName} <span>·</span> {currentState.branch || project.targetBranch}</p></div>
      </div>
    </header>
    {error ? <ErrorState message={error} onRetry={load} /> : null}
    <CanonicalDeploymentView canManage={Boolean(project.canManage)} canonicalFetchVersion={canonicalFetchVersion} currentState={currentState} onRefresh={load} projectId={projectId} />
  </div>;
}
