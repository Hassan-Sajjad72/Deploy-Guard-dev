import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  cancelPipelineRun,
  getPipelineRun,
  getPipelineRunEvents,
  getPipelineRuns,
  getProject,
  getProjectCurrentState,
  retryPipelineRun,
  startProjectAutomation,
} from "../api/projectApi.js";
import AppIcon from "../components/common/AppIcon.jsx";
import EmptyState from "../components/common/EmptyState.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { CollapsiblePanel, ProjectQuickNav, StatusBadge, formatStatus } from "../components/common/Premium.jsx";
import PipelineLiveLogPanel from "../components/projects/PipelineLiveLogPanel.jsx";
import PipelineRunPanel from "../components/projects/PipelineRunPanel.jsx";
import PipelineRunsTable from "../components/projects/PipelineRunsTable.jsx";
import { useToast } from "../hooks/useToast.js";

function duration(value) {
  if (!value && value !== 0) return "—";
  if (value < 1000) return `${value}ms`;
  const seconds = Math.round(value / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function timestamp(value) {
  return value ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)) : "—";
}

function PipelineStageTimeline({ stages, currentStep }) {
  return (
    <ol className="pipeline-stage-timeline">
      {stages.map((stage, index) => {
        const isCurrent = stage.stage === currentStep || stage.status === "running";
        const showMessage = isCurrent || ["failed", "blocked", "warning", "disabled_by_config"].includes(stage.status);
        return <li className={`pipeline-stage-row stage-${stage.status} ${isCurrent ? "is-current" : ""}`} key={stage.stage}>
          <div className="pipeline-stage-marker"><span>{["passed", "skipped"].includes(stage.status) ? <AppIcon name="check" size={13} /> : index + 1}</span></div>
          <div className="pipeline-stage-content"><div className="pipeline-stage-heading"><div><strong>{stage.label}</strong>{showMessage ? <p>{stage.message}</p> : null}</div><StatusBadge status={stage.status} /></div>{stage.blockedReason ? <div className="stage-error-copy">{stage.blockedReason}</div> : null}</div>
          <div className="pipeline-stage-time"><span>{timestamp(stage.startedAt)}</span><small>{duration(stage.durationMs)}</small></div>
        </li>;
      })}
    </ol>
  );
}

export default function ProjectPipeline() {
  const { projectId } = useParams();
  const { notify } = useToast();
  const [project, setProject] = useState(null);
  const [currentState, setCurrentState] = useState(null);
  const [runs, setRuns] = useState([]);
  const [selectedRun, setSelectedRun] = useState(null);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isStarting, setIsStarting] = useState(false);
  const [isRunActionPending, setIsRunActionPending] = useState(false);

  const shouldPoll = useMemo(() => Boolean(currentState?.stages?.some((stage) => ["pending", "running"].includes(stage.status))), [currentState]);

  useEffect(() => { loadPage(); }, [projectId]);
  useEffect(() => {
    if (!shouldPoll) return undefined;
    const timer = window.setInterval(refreshLatest, 4000);
    return () => window.clearInterval(timer);
  }, [projectId, selectedRun?.id, shouldPoll]);

  async function loadPage() {
    setIsLoading(true);
    try {
      const [projectResponse, runsResponse, stateResponse] = await Promise.all([getProject(projectId), getPipelineRuns(projectId), getProjectCurrentState(projectId)]);
      const nextRuns = runsResponse.pipelineRuns || [];
      setProject(projectResponse.project);
      setRuns(nextRuns);
      setCurrentState(stateResponse);
      setError("");
      if (nextRuns[0]) await selectRun(nextRuns[0]);
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setIsLoading(false);
    }
  }

  async function loadRuns(selectedRunId) {
    const response = await getPipelineRuns(projectId);
    const nextRuns = response.pipelineRuns || [];
    setRuns(nextRuns);
    if (selectedRunId) {
      const matching = nextRuns.find((run) => run.id === selectedRunId);
      if (matching) setSelectedRun(matching);
    }
    return nextRuns;
  }

  async function selectRun(run) {
    setSelectedRun(run);
    const response = await getPipelineRunEvents(projectId, run.id);
    setEvents(response.events || []);
  }

  async function refreshLatest() {
    try {
      const requests = [getProjectCurrentState(projectId), getPipelineRuns(projectId)];
      if (selectedRun?.id) requests.push(getPipelineRun(projectId, selectedRun.id), getPipelineRunEvents(projectId, selectedRun.id));
      const [stateResponse, runsResponse, runResponse, eventsResponse] = await Promise.all(requests);
      setCurrentState(stateResponse);
      setRuns(runsResponse.pipelineRuns || []);
      if (runResponse) setSelectedRun(runResponse.pipelineRun);
      if (eventsResponse) setEvents(eventsResponse.events || []);
    } catch (caughtError) {
      setError(caughtError.message);
    }
  }

  async function startRun() {
    setError("");
    setIsStarting(true);
    try {
      const response = await startProjectAutomation(projectId);
      if (response.automation?.status === "failed") throw new Error(response.automation.message || "Automation could not start.");
      const queuedRun = response.automation.pipelineRun;
      await loadRuns(queuedRun.id);
      await selectRun(queuedRun);
      setCurrentState(await getProjectCurrentState(projectId));
      notify("Deployment queued.", "success");
    } catch (caughtError) {
      setError(caughtError.message);
      notify(caughtError.message, "danger");
    } finally {
      setIsStarting(false);
    }
  }

  async function cancelRun() {
    const runId = currentState?.latestPipeline?.id;
    if (!runId) return;
    setError("");
    setIsRunActionPending(true);
    try {
      await cancelPipelineRun(projectId, runId);
      await refreshLatest();
      notify("Deployment cancelled.", "success");
    } catch (caughtError) {
      setError(caughtError.message);
      notify(caughtError.message, "danger");
    } finally {
      setIsRunActionPending(false);
    }
  }

  async function retryRun() {
    const runId = currentState?.latestPipeline?.id;
    if (!runId) return startRun();
    setError("");
    setIsRunActionPending(true);
    try {
      const response = await retryPipelineRun(projectId, runId);
      if (response.automation?.status === "failed" || !response.pipelineRun) throw new Error(response.automation?.message || "Automation could not restart.");
      await loadRuns(response.pipelineRun.id);
      await selectRun(response.pipelineRun);
      setCurrentState(await getProjectCurrentState(projectId));
      notify("Fresh deployment queued.", "success");
    } catch (caughtError) {
      setError(caughtError.message);
      notify(caughtError.message, "danger");
    } finally {
      setIsRunActionPending(false);
    }
  }

  if (isLoading) return <LoadingState message="Loading deployment run…" />;
  if (error && !project) return <ErrorState message={error} />;

  const latest = currentState?.latestPipeline;
  const activeStage = currentState?.stages?.find((stage) => stage.stage === currentState.currentStep) || currentState?.stages?.find((stage) => stage.status === "running");
  const needsRecovery = ["failed", "blocked"].includes(currentState?.overallStatus) || latest?.status === "cancelled";

  return (
    <div className="workspace-page pipeline-page">
      <header className="project-page-header pipeline-page-header">
        <div className="project-title-lockup"><span className="project-glyph project-glyph-large"><AppIcon name="pipeline" size={21} /></span><div><div className="project-title-row"><h1>Deployments</h1><StatusBadge status={latest?.status || "not_started"} /></div><p>{project?.name} <span>·</span> {latest?.id ? `Run ${latest.id.slice(0, 8)}` : "No run yet"}</p></div></div>
        <div className="pipeline-primary-controls">
          {!currentState.hasPipelineRun && project?.canManage ? <button className="button" disabled={isStarting} onClick={startRun} type="button"><AppIcon name="deploy" size={16} />{isStarting ? "Starting…" : "Start automation"}</button> : null}
          {currentState.runControls?.canRetry ? <button className="button" disabled={isRunActionPending} onClick={retryRun} type="button"><AppIcon name="deploy" size={16} />Retry</button> : null}
          {currentState.runControls?.canCancel ? <button className="danger-text-button" disabled={isRunActionPending} onClick={cancelRun} type="button">Cancel run</button> : null}
        </div>
      </header>

      <ProjectQuickNav projectId={projectId} />
      {error ? <ErrorState message={error} /> : null}

      {!currentState.hasPipelineRun ? <section className="workspace-empty-state compact-empty"><div className="empty-orbit"><AppIcon name="pipeline" size={26} /></div><h2>No deployment run yet</h2><p>DeployGuard will prepare the repository and create the first run automatically.</p></section> : null}

      {currentState.hasPipelineRun ? <div className="pipeline-layout">
        <main className="pipeline-main-column">
          <section className="pipeline-timeline-panel panel-flat">
            <div className="compact-section-heading"><div><p className="eyebrow">Deployment stages</p><h2>{currentState.currentStepLabel}</h2></div><div className="pipeline-overall-progress"><span>{currentState.progressPercentage}%</span><div className="progress-track"><i style={{ width: `${currentState.progressPercentage}%` }} /></div></div></div>
            <PipelineStageTimeline currentStep={currentState.currentStep} stages={currentState.stages || []} />
          </section>

          <PipelineLiveLogPanel events={events} />

          {runs.length ? <CollapsiblePanel summary={`Previous runs (${runs.length})`}><PipelineRunsTable onSelect={selectRun} runs={runs} selectedRunId={selectedRun?.id} /></CollapsiblePanel> : null}
          {runs.length ? <CollapsiblePanel summary="Artifacts and advanced diagnostics"><PipelineRunPanel events={events} projectId={projectId} selectedRun={selectedRun} /></CollapsiblePanel> : null}
        </main>

        <aside className="pipeline-detail-column">
          <section className="stage-detail-card panel-flat">
            <p className="eyebrow">Current stage</p>
            <div className="stage-detail-title"><span className={`active-stage-beacon ${needsRecovery ? "beacon-danger" : ""}`} /><h2>{activeStage?.label || currentState.currentStepLabel}</h2></div>
            <p>{activeStage?.message || currentState.userFacingStatus}</p>
            <dl><div><dt>Status</dt><dd><StatusBadge status={activeStage?.status || latest?.status} /></dd></div><div><dt>Started</dt><dd>{timestamp(activeStage?.startedAt || latest?.startedAt)}</dd></div><div><dt>Duration</dt><dd>{duration(activeStage?.durationMs)}</dd></div></dl>
          </section>

          {needsRecovery ? <section className="pipeline-recovery-card panel-flat"><span className="recovery-icon">!</span><p className="eyebrow">Recovery</p><h2>{currentState.failedStage ? `Failed at ${formatStatus(currentState.failedStage)}` : "Run stopped"}</h2><p>{latest?.failureMessage || currentState.blockedBy?.userMessage || currentState.userFacingStatus}</p><small>Use the controls at the top of this page to retry or cancel.</small></section> : null}

          {currentState.liveDeployment?.available ? <section className="project-live-card panel-flat"><div className="live-card-status"><span /><strong>Live</strong></div><h2>Deployment ready</h2><p>{currentState.liveDeployment.hostname}</p><a className="secondary-button" href={currentState.liveDeployment.url} rel="noreferrer" target="_blank">Open app <AppIcon name="arrow" size={14} /></a></section> : null}

          <CollapsiblePanel summary="Developer details"><dl className="developer-detail-grid"><div><dt>External CI</dt><dd>{currentState.externalCi?.status ? formatStatus(currentState.externalCi.status) : "Not requested"}</dd></div><div><dt>Required</dt><dd>{currentState.externalCi?.required ? "Yes" : "No"}</dd></div><div><dt>Terraform Apply</dt><dd>{currentState.environmentModes.terraformApplyEnabled ? "Enabled" : "Disabled"}</dd></div><div><dt>Worker</dt><dd>DeployGuard</dd></div></dl>{currentState.externalCi?.message ? <p className="developer-note">{currentState.externalCi.message}</p> : null}</CollapsiblePanel>
        </aside>
      </div> : null}

      {!runs.length && currentState.hasPipelineRun ? <EmptyState message="No persisted run history is available." /> : null}
    </div>
  );
}
