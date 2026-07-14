import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { generatePreflightReport, getProject, getProjectCurrentState, retryPipelineRun, runStackDetection, startProjectAutomation } from "../api/projectApi.js";
import AppIcon from "../components/common/AppIcon.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { CollapsiblePanel, StatusBadge } from "../components/common/Premium.jsx";
import { useToast } from "../hooks/useToast.js";

function statusLabel(state) {
  if (state.liveDeployment?.available) return "Live";
  if (["failed", "blocked"].includes(state.overallStatus)) return "Needs attention";
  if (state.overallStatus === "paused") return "Paused";
  if (["queued", "running"].includes(state.latestPipeline?.status)) return "Deploying";
  return "Ready";
}

export default function ProjectDetails() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { notify } = useToast();
  const [project, setProject] = useState(null);
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [projectResponse, current] = await Promise.all([getProject(projectId), getProjectCurrentState(projectId)]);
      setProject(projectResponse.project); setState(current); setError("");
    } catch (caught) { setError(caught.message); }
  }
  useEffect(() => { load(); }, [projectId]);
  useEffect(() => { if (!["queued", "running"].includes(state?.latestPipeline?.status)) return undefined; const timer = window.setInterval(load, 5000); return () => window.clearInterval(timer); }, [state?.latestPipeline?.status, projectId]);

  async function primaryAction() {
    setBusy(true); setError("");
    try {
      const action = state.nextAction;
      if (["failed", "blocked"].includes(state.overallStatus) && state.latestPipeline?.id) await retryPipelineRun(projectId, state.latestPipeline.id);
      else if (action?.type === "run_stack_detection") await runStackDetection(projectId);
      else if (action?.type === "generate_preflight") await generatePreflightReport(projectId);
      else if (action?.type === "start_pipeline") await startProjectAutomation(projectId);
      else { navigate(`/projects/${projectId}/pipeline`); return; }
      await load(); notify("Project updated.", "success");
    } catch (caught) { setError(caught.message); } finally { setBusy(false); }
  }

  if (!project || !state) return error ? <ErrorState message={error} /> : <LoadingState message="Loading project…" />;
  const needsAttention = ["failed", "blocked", "paused"].includes(state.overallStatus);
  const progress = state.progressPercentage ?? state.progress?.percentage ?? 0;
  const actionLabel = needsAttention ? (state.overallStatus === "paused" ? "Open pipeline" : "Retry deployment") : state.nextAction?.enabled ? state.nextAction.label : state.hasPipelineRun ? "Open pipeline" : "Continue";
  return <div className="workspace-page project-home-page">
    <header className="project-page-header"><div className="project-title-lockup"><span className="project-glyph project-glyph-large"><AppIcon name="box" size={21} /></span><div><div className="project-title-row"><h1>{project.name}</h1><StatusBadge status={state.overallStatus}>{statusLabel(state)}</StatusBadge></div><p><AppIcon name="github" size={14} />{project.repositoryFullName}<span>·</span><AppIcon name="branch" size={14} />{project.targetBranch}</p></div></div></header>
    {error ? <ErrorState message={error} /> : null}
    <div className="project-control-layout"><main className="project-control-main"><section className={`deployment-canvas panel-flat ${needsAttention ? "deployment-canvas-failed" : ""}`}><div className="deployment-canvas-header"><div><p className="eyebrow">Current deployment</p><div className="deployment-stage-title"><span className={["queued", "running"].includes(state.latestPipeline?.status) ? "active-stage-beacon" : ""} /><h2>{state.currentStepLabel}</h2></div><p>{state.userFacingStatus}</p></div><div className="deployment-progress-value"><strong>{progress}%</strong><span>{statusLabel(state)}</span></div></div><div className="deployment-progress-track"><span style={{ width: `${progress}%` }} /></div><div className="simple-primary-actions">{state.liveDeployment?.available ? <a className="button" href={state.liveDeployment.url} rel="noreferrer" target="_blank">Open live app</a> : <button className="button" disabled={busy} onClick={primaryAction} type="button">{busy ? "Working…" : actionLabel}</button>}<Link className="secondary-button" to={`/projects/${projectId}/pipeline`}>Open pipeline</Link></div></section>
      {needsAttention && state.overallStatus !== "paused" ? <section className="panel-flat compact-recovery-card"><p className="eyebrow">Deployment stopped</p><h2>{state.failedStageLabel || state.currentStepLabel}</h2><p>{state.latestPipeline?.failureMessage || state.blockedBy?.userMessage || "This deployment step needs attention before it can continue."}</p><Link className="secondary-button" to={`/projects/${projectId}/pipeline`}>Review pipeline</Link></section> : null}
    </main><aside className="project-control-aside">{state.liveDeployment?.available ? <section className="project-live-card panel-flat"><div className="live-card-status"><span /><strong>Live</strong></div><p>{state.liveDeployment.hostname}</p><a className="secondary-button" href={state.liveDeployment.url} rel="noreferrer" target="_blank">Open deployment</a></section> : null}<CollapsiblePanel summary="Developer details"><dl className="developer-detail-grid"><div><dt>App directory</dt><dd>{state.stackDetection?.appDirectory || project.appDirectory || "Automatic"}</dd></div><div><dt>Latest run</dt><dd>{state.latestPipeline?.id?.slice(0, 8) || "—"}</dd></div><div><dt>External CI</dt><dd>{state.environmentModes?.githubActionsRequired ? "Required" : "Optional"}</dd></div><div><dt>Apply</dt><dd>{state.environmentModes?.terraformApplyEnabled ? "Enabled" : "Disabled"}</dd></div></dl></CollapsiblePanel></aside></div>
  </div>;
}
