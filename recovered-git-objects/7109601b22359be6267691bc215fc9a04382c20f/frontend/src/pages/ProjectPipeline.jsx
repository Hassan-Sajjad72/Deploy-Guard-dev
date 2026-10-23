import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { approveTerraformApply, cancelPipelineRun, deployApprovalErrorMessage, getPipelineRuns, getProject, getProjectCurrentState, retryPipelineRun, startProjectAutomation } from "../api/projectApi.js";
import AppIcon from "../components/common/AppIcon.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { CollapsiblePanel, StatusBadge } from "../components/common/Premium.jsx";
import PipelineRunPanel from "../components/projects/PipelineRunPanel.jsx";
import PipelineRunsTable from "../components/projects/PipelineRunsTable.jsx";
import { useToast } from "../hooks/useToast.js";

function duration(value) { if (value === null || value === undefined) return "—"; if (value < 1000) return `${value}ms`; const seconds = Math.round(value / 1000); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; }
function time(value) { return value ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)) : "—"; }

function presentStages(current) {
  return (current.lifecycle || []).map((stage) => ({
    key: stage.stage,
    label: stage.label,
    status: ["requires_approval", "disabled_by_config"].includes(stage.status) ? "paused" : stage.status,
    message: stage.message,
    startedAt: stage.startedAt,
    endedAt: stage.endedAt,
    durationMs: stage.durationMs,
    technicalStageCount: stage.technicalStages?.length || 0,
  }));
}

function recoveryHref(projectId, stage = "") {
  if (/state|lockfile/.test(stage)) return `/projects/${projectId}/state`;
  if (/dockerfile|security/.test(stage)) return `/projects/${projectId}/security`;
  if (/cost/.test(stage)) return `/projects/${projectId}/costs`;
  if (/cloud|terraform|state/.test(stage)) return `/projects/${projectId}/infrastructure`;
  if (/detect/.test(stage)) return `/projects/${projectId}/detection`;
  if (/container/.test(stage)) return `/projects/${projectId}/preflight`;
  if (/repository/.test(stage)) return `/projects/${projectId}/settings`;
  if (/deploy|health/.test(stage)) return `/projects/${projectId}/orchestration`;
  return `/projects/${projectId}/settings`;
}

export default function ProjectPipeline() {
  const { projectId } = useParams();
  const { notify } = useToast();
  const [project, setProject] = useState(null);
  const [current, setCurrent] = useState(null);
  const [runs, setRuns] = useState([]);
  const [selectedRun, setSelectedRun] = useState(null);
  const [error, setError] = useState("");
  const [approvalError, setApprovalError] = useState("");
  const [busy, setBusy] = useState(false);
  const approvalInFlight = useRef(false);
  async function load() { try { const [p, s, r] = await Promise.all([getProject(projectId), getProjectCurrentState(projectId), getPipelineRuns(projectId)]); setProject(p.project); setCurrent(s); setRuns(r.pipelineRuns || []); setSelectedRun((selected) => selected || r.pipelineRuns?.[0] || null); setError(""); } catch (caught) { setError(caught.message); } }
  useEffect(() => { load(); }, [projectId]);
  useEffect(() => { if (!current?.isDeploymentJobActive) return undefined; const timer = window.setInterval(load, 4000); return () => window.clearInterval(timer); }, [current?.isDeploymentJobActive, projectId]);
  const stages = useMemo(() => current ? presentStages(current) : [], [current]);
  async function start() { setBusy(true); try { await startProjectAutomation(projectId); await load(); notify("Deployment queued.", "success"); } catch (caught) { setError(caught.message); } finally { setBusy(false); } }
  async function cancel() { if (!window.confirm("Cancel this deployment run?")) return; setBusy(true); try { await cancelPipelineRun(projectId, current.activePipelineRunId); await load(); notify("Deployment cancelled.", "success"); } catch (caught) { setError(caught.message); } finally { setBusy(false); } }
  async function retry() { setBusy(true); try { await retryPipelineRun(projectId, current.latestPipeline.id); await load(); notify("Deployment retry queued.", "success"); } catch (caught) { setError(caught.message); } finally { setBusy(false); } }
  async function approveApply() {
    if (approvalInFlight.current) return;
    if (!window.confirm("Terraform apply will create or update AWS resources and may incur cost. Deploy to AWS?")) return;
    approvalInFlight.current = true;
    setApprovalError("");
    setError("");
    setBusy(true);
    try {
      await approveTerraformApply(projectId, current?.latestPipeline?.id);
      await load();
      notify("Terraform apply approved. Deployment is resuming.", "success");
    } catch (caught) {
      setApprovalError(deployApprovalErrorMessage(caught));
    } finally {
      approvalInFlight.current = false;
      setBusy(false);
    }
  }
  if (!project || !current) return error ? <ErrorState message={error} /> : <LoadingState message="Loading pipeline…" />;
  const status = current.latestPipeline?.status || "not_started";
  const failed = ["failed", "blocked"].includes(current.overallStatus) || status === "cancelled";
  const completed = stages.filter((stage) => ["passed", "skipped", "warning"].includes(stage.status)).length;
  const currentIndex = stages.findIndex((stage) => ["running", "failed", "blocked", "paused", "pending"].includes(stage.status));
  const progress = current.progressPercentage ?? Math.round((completed / stages.length) * 100);
  const failedStage = stages.find((stage) => ["failed", "blocked"].includes(stage.status));
  const recoveryMessage = current.latestPipeline?.failureMessage || current.blockedBy?.userMessage || failedStage?.message || "Resolve the failed stage, then retry the deployment.";
  const isStateRecovery = /terraform state|s3 lockfile|state_recovery/i.test(`${failedStage?.key || ""} ${recoveryMessage}`);
  const isEcsFailure = /ecs|container|target.*health|app is listening/i.test(`${failedStage?.key || ""} ${recoveryMessage}`);

  return <div className="workspace-page pipeline-page">
    <header className="project-page-header"><div className="project-title-lockup"><span className="project-glyph project-glyph-large"><AppIcon name="pipeline" size={21} /></span><div><div className="project-title-row"><h1>Pipeline</h1>{current.hasPipelineRun ? <StatusBadge status={status} /> : null}</div><p>{project.name} <span>·</span> {project.targetBranch} {current.latestPipeline?.id ? <><span>·</span> Run {current.latestPipeline.id.slice(0, 8)}</> : null}</p></div></div><div className="quick-actions">{current.isDeploymentJobActive && current.runControls?.canCancel ? <button className="danger-text-button" disabled={busy} onClick={cancel} type="button">Cancel run</button> : null}{current.runControls?.canRetry ? <button className="button" disabled={busy} onClick={retry} type="button">Retry deployment</button> : null}</div></header>
    {error ? <ErrorState message={error} /> : null}
    {current.runControls?.canApproveApply ? <section className="simple-recovery-card panel-flat"><div><p className="eyebrow">Final approval</p><h2>Ready to deploy to AWS</h2><p>Terraform apply will create or update AWS resources and may incur cost. Nothing is applied until you approve this run.</p>{approvalError ? <p className="inline-action-error" role="alert">{approvalError}</p> : null}</div><button className="button" disabled={busy} onClick={approveApply} type="button">{busy ? "Queuing…" : "Deploy to AWS"}</button></section> : null}
    {!current.hasPipelineRun ? <section className="simple-pipeline-empty panel-flat"><div className="empty-orbit"><AppIcon name="pipeline" size={26} /></div><div><p className="eyebrow">Ready</p><h2>No deployment run yet</h2><p>Complete repository analysis, then start the deployment lifecycle.</p></div>{current.nextAction?.type === "start_pipeline" ? <button className="button" disabled={busy} onClick={start} type="button">Start deployment</button> : <Link className="button" to={`/projects/${projectId}`}>Continue setup</Link>}</section> : <>
      <section className="pipeline-progress-summary panel-flat"><div><p className="eyebrow">Deployment progress</p><h2>{current.currentStepLabel}</h2><p>{current.userFacingStatus}</p></div><div className="pipeline-progress-metric"><strong>{progress}%</strong><span>Stage {Math.max(1, currentIndex + 1)} of {stages.length}</span></div><div className="deployment-progress-track"><span style={{ width: `${progress}%` }} /></div></section>
      <section className="simple-pipeline-card panel-flat"><div className="compact-section-heading"><div><p className="eyebrow">Deployment lifecycle</p><h2>Stages</h2><p>Passed, active, failed, blocked, and pending stages follow the backend's canonical lifecycle.</p></div><StatusBadge status={status} /></div><ol className="simple-pipeline-stages">{stages.map((stage, index) => <li className={`simple-pipeline-stage stage-${stage.status} ${index === currentIndex ? "is-current" : ""}`} key={stage.key}><span className="simple-stage-marker">{["passed", "skipped", "warning"].includes(stage.status) ? <AppIcon name="check" size={14} /> : index + 1}</span><div><strong>{stage.label}</strong><small>{stage.message}</small>{stage.technicalStageCount ? <small>{stage.technicalStageCount} internal stage{stage.technicalStageCount === 1 ? "" : "s"}</small> : null}</div><StatusBadge status={stage.status} /><div className="pipeline-stage-time"><span>{time(stage.startedAt)}</span><small>{duration(stage.durationMs)}</small></div></li>)}</ol></section>
    </>}
    {failed ? <section className="simple-recovery-card panel-flat"><div><p className="eyebrow">Recovery</p><h2>{isStateRecovery ? "S3 state lockfile recovery" : isEcsFailure ? "ECS task failed to start" : `${failedStage?.label || current.failedStageLabel || current.currentStepLabel} needs attention`}</h2><p>{recoveryMessage}</p></div><div className="quick-actions"><Link className="secondary-button" to={isStateRecovery ? `/projects/${projectId}/state` : isEcsFailure ? `/projects/${projectId}/orchestration` : recoveryHref(projectId, failedStage?.key)}>{isStateRecovery ? "Open state recovery" : isEcsFailure ? "View ECS diagnostics" : "Open fix page"}</Link>{current.environmentModes?.aiAssistantEnabled ? <Link className="secondary-button" to={`/projects/${projectId}/troubleshooting`}>View troubleshooting</Link> : null}{current.runControls?.canRetry ? <button className="button" disabled={busy} onClick={retry} type="button">Retry deployment</button> : null}</div></section> : null}
    {runs.length ? <CollapsiblePanel summary={`Run history (${runs.length})`}><PipelineRunsTable onSelect={setSelectedRun} runs={runs} selectedRunId={selectedRun?.id} />{selectedRun ? <PipelineRunPanel selectedRun={selectedRun} /> : null}</CollapsiblePanel> : null}
    <CollapsiblePanel summary="Developer details"><dl className="developer-detail-grid"><div><dt>Internal current stage</dt><dd>{current.latestPipeline?.failedStage || current.currentStep}</dd></div><div><dt>External CI</dt><dd>{current.environmentModes?.githubActionsRequired ? "Required" : "Optional"}</dd></div><div><dt>Trivy</dt><dd>{current.environmentModes?.trivyScanEnabled ? current.environmentModes?.securityGateMode === "bypass" ? "Advisory only" : "Enabled" : "Bypassed"}</dd></div><div><dt>FinOps</dt><dd>{current.environmentModes?.finopsMockMode ? "Mock / API disabled" : "Infracost enabled"}</dd></div><div><dt>AI assistant</dt><dd>{current.environmentModes?.aiAssistantEnabled ? "Enabled" : "Disabled"}</dd></div><div><dt>Apply gate</dt><dd>{current.environmentModes?.terraformApplyEnabled ? current.environmentModes?.terraformApplyRequiresApproval ? "Approval required" : "Enabled" : "Safe mode"}</dd></div><div><dt>Latest run</dt><dd>{current.latestPipeline?.id || "—"}</dd></div></dl></CollapsiblePanel>
  </div>;
}
