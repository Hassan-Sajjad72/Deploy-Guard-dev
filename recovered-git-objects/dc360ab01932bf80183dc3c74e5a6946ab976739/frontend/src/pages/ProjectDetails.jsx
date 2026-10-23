import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getProject, getProjectCurrentState } from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import AppIcon from "../components/common/AppIcon.jsx";
import ProjectOverviewLifecycle from "../components/projects/ProjectOverviewLifecycle.jsx";
import { redirectDeletedProject, subscribeProjectStateChanged } from "../utils/projectStateSync.js";
import { projectStatePresentation } from "../utils/projectStatePresentation.js";
import { useSerializedProjectRefresh } from "../hooks/useSerializedProjectRefresh.js";
import { formatRelativeTime } from "../utils/time.js";
import "../styles/pages/overview.css";

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
      if (redirectDeletedProject(caught, navigate)) return;
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

  const repository = currentState.repository || project.repositoryFullName;
  const branch = currentState.branch || project.targetBranch;
  const releaseCommit = currentState.stableRelease?.commit ? currentState.stableRelease.commit.slice(0, 12) : null;
  const services = project.services || [];


  return <div className="workspace-page project-overview-page dg-overview" data-authoritative-state={projectStatePresentation(currentState).state}>
    <header className="dg-ov-head">
      <div className="dg-ov-identity">
        <div className="dg-ov-title">
          <p className="dg-ov-kicker">Release control{project.environmentName ? <span className="dg-ov-env">{project.environmentName}</span> : null}</p>
          <div className="dg-ov-title-row"><h1>{project.name}</h1></div>
          <p className="dg-ov-source">
            {repository ? <span><AppIcon name="github" size={14} />{repository}</span> : null}
            {branch ? <span className="is-mono"><AppIcon name="branch" size={14} />{branch}</span> : null}
          </p>
        </div>
        {currentState.stableUrl ? <div className="dg-ov-domain is-live">
          <span className="dg-ov-domain-label">Live application</span>
          <a href={currentState.stableUrl} rel="noreferrer" target="_blank"><span aria-hidden="true" className="dg-ov-domain-dot" />Open application <span aria-hidden="true">↗</span></a>
        </div> : null}
      </div>
      <dl className="dg-ov-meta" aria-label="Release metadata">
        {project.environmentName ? <div><dt>Environment</dt><dd>{project.environmentName}</dd></div> : null}
        <div><dt>Release</dt><dd className="is-mono">{releaseCommit || "No verified release"}</dd></div>
        {currentState.stableRelease?.verifiedAt ? <div><dt>Verified</dt><dd title={currentState.stableRelease.verifiedAt}>{formatRelativeTime(currentState.stableRelease.verifiedAt)}</dd></div> : null}
        {currentState.latestAttempt?.workflowRunId ? <div><dt>Workflow run</dt><dd className="is-mono">#{currentState.latestAttempt.workflowRunId}</dd></div> : null}
        <div><dt>Services</dt><dd>{services.length || "—"}</dd></div>
      </dl>
    </header>
    {error ? <ErrorState message={error} onRetry={load} /> : null}
    <ProjectOverviewLifecycle canManage={Boolean(project.canManage)} currentState={currentState} onRefresh={load} projectId={projectId} />
    {services.length ? <section aria-labelledby="overview-services" className="dg-ov-services">
      <header><div><p className="dg-ov-kicker">Runtime</p><h2 id="overview-services">Configured services</h2></div><span>{services.length} service{services.length === 1 ? "" : "s"}</span></header>
      <div className="dg-ov-roster" role="list">
        <div aria-hidden="true" className="dg-ov-roster-head"><span>Service</span><span>Directory</span></div>
        {services.map((service) => <div className="dg-ov-roster-row" key={service.id} role="listitem">
          <span className="dg-ov-service-name"><span aria-hidden="true" className="dg-ov-service-mark"><AppIcon name="box" size={14} /></span><strong>{service.name}</strong></span>
          <span className="dg-ov-service-dir">{service.serviceDirectory === "." ? "Repository root" : service.serviceDirectory}</span>
        </div>)}
      </div>
    </section> : null}
  </div>;
}
