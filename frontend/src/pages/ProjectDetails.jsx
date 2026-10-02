import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getProject, getProjectCurrentState } from "../api/projectApi.js";
import AppIcon from "../components/common/AppIcon.jsx";
import { Status } from "../components/common/DesignSystem.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import Time from "../components/common/Time.jsx";
import ProjectOverviewLifecycle from "../components/projects/ProjectOverviewLifecycle.jsx";
import { redirectDeletedProject, subscribeProjectStateChanged } from "../utils/projectStateSync.js";
import { projectStatePresentation } from "../utils/projectStatePresentation.js";
import { useSerializedProjectRefresh } from "../hooks/useSerializedProjectRefresh.js";
import { formatElapsed } from "../utils/time.js";

const ACTIVE_ATTEMPT = new Set(["preparing", "queued", "building", "deploying", "verifying", "destroying"]);
const IN_PROGRESS_LABEL = { deploy: "Deploying", rollback: "Rolling back", destroy: "Destroying" };

/** Result wording for the latest attempt; an in-progress attempt is named by what it is doing. */
function attemptResult(latest) {
  if (ACTIVE_ATTEMPT.has(latest?.status)) return [latest.status === "queued" ? "Queued" : IN_PROGRESS_LABEL[latest.operationType] || "Deploying", "info"];
  if (latest?.status === "destroyed") return ["Destroyed", "neutral"];
  if (latest?.status === "failed_application") return ["Failed", "danger"];
  if (latest?.status === "platform_attention") return ["Needs attention", "warning"];
  if (latest?.status === "live" || latest?.outcome === "completed") return ["Succeeded", "success"];
  return ["Recorded", "neutral"];
}

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
    return error ? <div className="page"><ErrorState message={error} onRetry={load} title="This project could not be loaded" /></div> : <LoadingState message="Loading project…" />;
  }

  const repository = currentState.repository || project.repositoryFullName;
  const release = currentState.stableRelease;
  const services = project.services || [];
  const entrypointId = project.applicationEntryPointServiceId || (services.length === 1 ? services[0].id : null);
  const latest = currentState.latestAttempt;
  const [latestLabel, latestTone] = attemptResult(latest);
  const latestActive = latestTone === "info";
  const latestDuration = latestActive ? null : formatElapsed(latest?.startedAt, latest?.completedAt);
  const latestTime = latestActive ? latest?.startedAt || latest?.occurredAt : latest?.completedAt || latest?.occurredAt;
  const operationName = latest?.operationType === "destroy" ? "Destroy" : latest?.operationType === "rollback" ? "Rollback" : "Deploy";

  return <div className="page overview-page" data-authoritative-state={projectStatePresentation(currentState).state}>
    {error ? <ErrorState message={error} onRetry={load} title="Showing the last known state" /> : null}
    <ProjectOverviewLifecycle canManage={Boolean(project.canManage)} currentState={currentState} onRefresh={load} project={project} projectId={projectId} />

    <div className="overview-grid">
      {release ? <section aria-labelledby="overview-release" className="section">
        <div className="section-head"><h2 id="overview-release">Current release</h2></div>
        <dl className="panel panel-pad facts-list overview-release">
          <div><dt>Release</dt><dd>{release.revision}</dd></div>
          <div><dt>Commit</dt><dd>{repository ? <a className="link mono" href={`https://github.com/${repository}/commit/${release.commit}`} rel="noreferrer" target="_blank" title={release.commit}>{release.commit.slice(0, 12)}</a> : <span className="mono">{release.commit.slice(0, 12)}</span>}</dd></div>
          <div><dt>Verified</dt><dd><Time value={release.verifiedAt || release.promotedAt} /></dd></div>
          <div><dt>Rollback</dt><dd>{release.rollbackAvailable ? "Previous release available" : "No previous release"}</dd></div>
        </dl>
      </section> : null}

      <section aria-labelledby="overview-services" className="section">
        <div className="section-head"><h2 id="overview-services">Services<span className="count">{services.length}</span></h2><Link className="link section-link" to={`/projects/${projectId}/settings?section=services`}>Configure</Link></div>
        {services.length ? <ul className="rows overview-services">
          {services.map((service) => <li key={service.id}>
            <span className="service-name"><AppIcon name="box" size={16} /><strong translate="no">{service.name}</strong>{service.id === entrypointId && services.length > 1 ? <span className="badge tone-neutral">Public</span> : null}</span>
            <span className={service.serviceDirectory === "." ? "service-dir is-root" : "service-dir mono"} title={service.serviceDirectory}>{service.serviceDirectory === "." ? "Repository root" : service.serviceDirectory}</span>
            <span className="service-port muted num">{service.servicePort ? `Port ${service.servicePort}` : "Port detected at deploy"}</span>
          </li>)}
        </ul> : <p className="muted">No services are configured. <Link className="link" to={`/projects/${projectId}/settings?section=services`}>Add a service</Link></p>}
      </section>
    </div>

    {latest ? <section aria-labelledby="overview-latest" className="section">
      <div className="section-head"><h2 id="overview-latest">Latest deployment</h2><Link className="link section-link" to={`/projects/${projectId}/pipeline`}>All deployments</Link></div>
      <Link className="panel latest-attempt" to={`/projects/${projectId}/pipeline`}>
        <Status active={latestTone === "info"} tone={latestTone}>{latestLabel}</Status>
        <span className="latest-attempt-main">{operationName}{latest.attempt ? <> · attempt {latest.attempt}</> : null}{latest.commit ? <> · <span className="mono">{String(latest.commit).slice(0, 7)}</span></> : null}</span>
        <span className="latest-attempt-meta muted">{latestActive ? "Started " : latestDuration ? `Took ${latestDuration} · ` : ""}<Time value={latestTime} /></span>
        <AppIcon className="muted" name="chevron" size={16} />
      </Link>
    </section> : null}
  </div>;
}
