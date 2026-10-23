import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  cancelPipelineRun,
  getProject,
  getProjectCurrentState,
  retryPipelineRun,
  startProjectAutomation,
} from "../api/projectApi.js";
import AppIcon from "../components/common/AppIcon.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { CollapsiblePanel, ProjectQuickNav, RecentActivityTimeline, StatusBadge, formatStatus } from "../components/common/Premium.jsx";
import { useToast } from "../hooks/useToast.js";

function formatTime(value) {
  return value ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)) : "--:--:--";
}

function setupStages(state) {
  return [
    { stage: "repository", label: "Repository", status: state.repository?.status === "connected" ? "passed" : "running" },
    { stage: "detection", label: "Detection", status: state.stackDetection?.status === "passed" ? "passed" : state.stackDetection?.status === "failed" ? "failed" : "pending" },
    { stage: "preflight", label: "Pre-flight", status: state.preflight?.status === "passed" ? "passed" : state.preflight?.status === "failed" ? "failed" : "pending" },
    { stage: "pipeline", label: "Deploy", status: state.hasPipelineRun ? state.latestPipeline?.status : "pending" },
  ];
}

export default function ProjectDetails() {
  const { projectId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { notify } = useToast();
  const autoStartHandled = useRef(false);
  const [project, setProject] = useState(null);
  const [currentState, setCurrentState] = useState(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isAutomating, setIsAutomating] = useState(false);
  const [isRunActionPending, setIsRunActionPending] = useState(false);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    let mounted = true;
    async function loadProject() {
      setIsLoading(true);
      try {
        const [projectResponse, stateResponse] = await Promise.all([getProject(projectId), getProjectCurrentState(projectId)]);
        if (mounted) { setProject(projectResponse.project); setCurrentState(stateResponse); setError(""); }
      } catch (caughtError) {
        if (mounted) setError(caughtError.message);
      } finally {
        if (mounted) setIsLoading(false);
      }
    }
    loadProject();
    return () => { mounted = false; };
  }, [projectId]);

  useEffect(() => {
    if (!currentState || !["pipeline", "deployment"].includes(currentState.phase) || currentState.overallStatus !== "running") return undefined;
    const timer = window.setInterval(() => getProjectCurrentState(projectId).then(setCurrentState).catch(() => undefined), 5000);
    return () => window.clearInterval(timer);
  }, [currentState?.overallStatus, currentState?.phase, projectId]);

  useEffect(() => {
    if (!location.state?.startAutomation || autoStartHandled.current) return;
    autoStartHandled.current = true;
    navigate(location.pathname, { replace: true, state: {} });
    runAutomation();
  }, [location.pathname, location.state?.startAutomation, navigate, projectId]);

  async function refreshState() {
    const response = await getProjectCurrentState(projectId);
    setCurrentState(response);
    return response;
  }

  async function runAutomation() {
    setActionError("");
    setIsAutomating(true);
    try {
      const response = await startProjectAutomation(projectId);
      await refreshState();
      if (response.automation?.status === "failed") throw new Error(response.automation.message || "Automation could not start.");
      notify("Automation started.", "success");
    } catch (caughtError) {
      setActionError(caughtError.message);
      notify(caughtError.message, "danger");
    } finally {
      setIsAutomating(false);
    }
  }

  async function cancelRun() {
    if (!currentState?.latestPipeline?.id) return;
    setActionError("");
    setIsRunActionPending(true);
    try {
      await cancelPipelineRun(projectId, currentState.latestPipeline.id);
      await refreshState();
      notify("Automation run cancelled.", "success");
    } catch (caughtError) {
      setActionError(caughtError.message);
      notify(caughtError.message, "danger");
    } finally {
      setIsRunActionPending(false);
    }
  }

  async function retryRun() {
    if (!currentState?.latestPipeline?.id) return runAutomation();
    setActionError("");
    setIsRunActionPending(true);
    try {
      const response = await retryPipelineRun(projectId, currentState.latestPipeline.id);
      if (response.automation?.status === "failed") throw new Error(response.automation.message || "Automation could not restart.");
      await refreshState();
      notify("Fresh automation run queued.", "success");
    } catch (caughtError) {
      setActionError(caughtError.message);
      notify(caughtError.message, "danger");
    } finally {
      setIsRunActionPending(false);
    }
  }

  if (isLoading) return <LoadingState message="Loading project overview…" />;
  if (error || !project || !currentState) return <ErrorState message={error || "Project state is unavailable."} />;

  const isActive = ["queued", "running"].includes(currentState.latestPipeline?.status);
  const needsRecovery = ["failed", "blocked"].includes(currentState.overallStatus) || currentState.latestPipeline?.status === "cancelled";
  const stages = currentState.showFullLifecycle ? currentState.stages || [] : setupStages(currentState);
  const logPreview = (currentState.recentActivity || []).filter((item) => item.id && !String(item.id).includes("project-")).slice(0, 5);
  const highLevelActivity = (currentState.recentActivity || []).filter((item) => /^(project|detection|preflight|scan|cost|deployment)-/.test(String(item.id))).slice(0, 5);
  const stack = currentState.stackDetection?.status === "passed"
    ? [currentState.stackDetection.language, currentState.stackDetection.framework].filter(Boolean).join(" · ")
    : "Not detected";

  return (
    <div className="workspace-page project-home-page">
      <header className="project-page-header">
        <div className="project-title-lockup"><span className="project-glyph project-glyph-large"><AppIcon name="box" size={21} /></span><div><div className="project-title-row"><h1>{project.name}</h1><StatusBadge status={currentState.overallStatus} /></div><p><AppIcon name="github" size={14} />{project.repositoryFullName || project.repositoryUrl}<span>·</span><AppIcon name="branch" size={14} />{project.targetBranch || "No branch"}</p></div></div>
        {currentState.liveDeployment?.available ? <a className="button" href={currentState.liveDeployment.url} rel="noreferrer" target="_blank">Open app <AppIcon name="arrow" size={15} /></a> : null}
      </header>

      <ProjectQuickNav projectId={projectId} />
      {actionError ? <ErrorState message={actionError} /> : null}

      <div className="project-control-layout">
        <main className="project-control-main">
          <section className={`deployment-canvas panel-flat ${isActive ? "deployment-canvas-active" : ""} ${needsRecovery ? "deployment-canvas-failed" : ""}`}>
            <div className="deployment-canvas-header"><div><p className="eyebrow">Latest deployment</p><div className="deployment-stage-title"><span className="active-stage-beacon" /><h2>{currentState.currentStepLabel}</h2></div><p>{currentState.userFacingStatus}</p></div><div className="deployment-progress-value"><strong>{currentState.progressPercentage}%</strong><span>{formatStatus(currentState.latestPipeline?.status || currentState.phase)}</span></div></div>
            <div aria-label={`${currentState.progressPercentage}% deployment progress`} aria-valuemax="100" aria-valuemin="0" aria-valuenow={currentState.progressPercentage} className="deployment-progress-track" role="progressbar"><span style={{ width: `${currentState.progressPercentage}%` }} /></div>
            <ol className="overview-stage-rail">
              {stages.map((stage) => <li className={`stage-${stage.status} ${stage.stage === currentState.currentStep ? "is-current" : ""}`} key={stage.stage}><span /><small>{stage.label}</small></li>)}
            </ol>
            <div className="deployment-canvas-footer"><span>Run {currentState.latestPipeline?.id ? currentState.latestPipeline.id.slice(0, 8) : "not started"}</span><Link to={`/projects/${projectId}/pipeline`}>View deployment details <AppIcon name="arrow" size={14} /></Link></div>
          </section>

          <section className="project-log-preview panel-flat">
            <div className="compact-section-heading"><div><p className="eyebrow">Build output</p><h2>Recent logs</h2></div><Link className="text-link" to={`/projects/${projectId}/pipeline`}>Full logs <AppIcon name="arrow" size={14} /></Link></div>
            <div className="mini-console" role="log">
              {logPreview.map((event) => <div className={`mini-console-line log-${event.status}`} key={event.id}><time>{formatTime(event.createdAt)}</time><span>{event.stage}</span><p>{event.message}</p></div>)}
              {!logPreview.length ? <div className="console-empty">Worker output will appear after automation starts.</div> : null}
            </div>
          </section>

          <section className="project-activity panel-flat">
            <div className="compact-section-heading"><div><p className="eyebrow">Project activity</p><h2>Recent events</h2></div></div>
            <RecentActivityTimeline activity={highLevelActivity.length ? highLevelActivity : currentState.recentActivity?.slice(0, 4)} />
          </section>
        </main>

        <aside className="project-control-aside">
          <section className={`run-control-card panel-flat ${needsRecovery ? "run-control-danger" : ""}`}>
            <div><p className="eyebrow">Run controls</p><h2>{isActive ? "Deployment in progress" : needsRecovery ? "Deployment needs attention" : currentState.hasPipelineRun ? "Deployment complete" : "Ready to deploy"}</h2><p>{needsRecovery ? currentState.blockedBy?.userMessage || currentState.latestPipeline?.failureMessage : isActive ? "DeployGuard is advancing through the pipeline automatically." : "Start or inspect the latest deployment."}</p></div>
            <div className="run-control-actions">
              {!currentState.hasPipelineRun && project.canManage ? <button className="button" disabled={isAutomating} onClick={runAutomation} type="button"><AppIcon name="deploy" size={16} />{isAutomating ? "Starting…" : "Start automation"}</button> : null}
              {currentState.runControls?.canRetry ? <button className="button" disabled={isRunActionPending} onClick={retryRun} type="button"><AppIcon name="deploy" size={16} />Retry automation</button> : null}
              <Link className="secondary-button" to={`/projects/${projectId}/pipeline`}><AppIcon name="logs" size={16} />View logs & details</Link>
              {currentState.runControls?.canCancel ? <button className="danger-text-button" disabled={isRunActionPending} onClick={cancelRun} type="button">Cancel run</button> : null}
            </div>
          </section>

          {currentState.liveDeployment?.available ? <section className="project-live-card panel-flat"><div className="live-card-status"><span /><strong>Live</strong></div><h2>Deployment ready</h2><p>{currentState.liveDeployment.hostname}</p><a className="secondary-button" href={currentState.liveDeployment.url} rel="noreferrer" target="_blank">Visit deployment <AppIcon name="arrow" size={14} /></a></section> : null}

          <section className="project-metadata-card panel-flat">
            <div className="compact-section-heading"><div><p className="eyebrow">Project</p><h2>Metadata</h2></div><Link className="icon-button" to={`/projects/${projectId}/settings`}><AppIcon name="settings" size={16} /></Link></div>
            <dl><div><dt>Stack</dt><dd>{stack}</dd></div><div><dt>Branch</dt><dd>{project.targetBranch || "—"}</dd></div><div><dt>Latest run</dt><dd>{currentState.latestPipeline?.id?.slice(0, 8) || "—"}</dd></div><div><dt>Started</dt><dd>{currentState.latestPipeline?.startedAt ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(currentState.latestPipeline.startedAt)) : "—"}</dd></div></dl>
          </section>

          <CollapsiblePanel summary="Developer details">
            <dl className="developer-detail-grid"><div><dt>Terraform Apply</dt><dd>{currentState.environmentModes.terraformApplyEnabled ? "Enabled" : "Disabled"}</dd></div><div><dt>FinOps</dt><dd>{currentState.environmentModes.finopsMockMode ? "Mock" : "Real"}</dd></div><div><dt>State</dt><dd>{currentState.environmentModes.stateMockMode ? "Mock" : "Remote"}</dd></div><div><dt>External CI</dt><dd>{currentState.environmentModes.githubActionsRequired ? "Required" : "Optional"}</dd></div></dl>
            {currentState.deployDisabledReasons?.length ? <ul className="compact-list">{currentState.deployDisabledReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : null}
          </CollapsiblePanel>
        </aside>
      </div>
    </div>
  );
}
