import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { cancelPipelineRun, getProject, getProjectCurrentState, retryPipelineRun, startProjectAutomation } from "../api/projectApi.js";
import AppIcon from "../components/common/AppIcon.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { StatusBadge } from "../components/common/Premium.jsx";
import { useToast } from "../hooks/useToast.js";

const STAGES = [
  ["preparing_repository", "Preparing repository", /validate|prepar|queue|clone|repository/],
  ["detecting_application", "Detecting application", /detect|snapshot/],
  ["preparing_container", "Preparing container", /template|dockerfile_generated|dockerignore/],
  ["checking_dockerfile", "Checking Dockerfile", /dockerfile_check|security|trivy|scan/],
  ["building_image", "Building image", /docker_build|building_image|tagging_image|ecr/],
  ["estimating_cost", "Estimating cost", /finops|cost/],
  ["preparing_cloud", "Preparing cloud resources", /terraform_plan|apply_gate|state_lock|terraform_apply|storage|efs|infrastructure/],
  ["deploying_application", "Deploying application", /ecs|deploy/],
  ["checking_health", "Checking application health", /alb|health|stable|observability/],
  ["deployment_complete", "Deployment complete", /completed|release/],
];

function rank(status) { return ({ failed: 6, blocked: 5, requires_approval: 4, disabled_by_config: 4, running: 3, pending: 2, passed: 1, skipped: 1, warning: 1, not_started: 0 }[status] ?? 0); }
function presentStages(current) {
  const technical = current.stages || [];
  return STAGES.map(([key, label, match]) => {
    const matching = technical.filter((stage) => match.test(stage.stage));
    const strongest = [...matching].sort((a, b) => rank(b.status) - rank(a.status))[0];
    let status = strongest?.status || "not_started";
    if (status === "requires_approval" || status === "disabled_by_config") status = "paused";
    if (current.liveDeployment?.available && key === "deployment_complete") status = "passed";
    return { key, label, status, message: strongest?.message };
  });
}

export default function ProjectPipeline() {
  const { projectId } = useParams();
  const { notify } = useToast();
  const [project, setProject] = useState(null);
  const [current, setCurrent] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() { try { const [p, s] = await Promise.all([getProject(projectId), getProjectCurrentState(projectId)]); setProject(p.project); setCurrent(s); setError(""); } catch (caught) { setError(caught.message); } }
  useEffect(() => { load(); }, [projectId]);
  useEffect(() => { if (!["queued", "running"].includes(current?.latestPipeline?.status)) return undefined; const timer = window.setInterval(load, 4000); return () => window.clearInterval(timer); }, [current?.latestPipeline?.status, projectId]);
  const stages = useMemo(() => current ? presentStages(current) : [], [current]);
  async function start() { setBusy(true); try { await startProjectAutomation(projectId); await load(); notify("Deployment queued.", "success"); } catch (caught) { setError(caught.message); } finally { setBusy(false); } }
  async function cancel() { if (!window.confirm("Cancel this deployment run?")) return; setBusy(true); try { await cancelPipelineRun(projectId, current.latestPipeline.id); await load(); } catch (caught) { setError(caught.message); } finally { setBusy(false); } }
  async function retry() { setBusy(true); try { await retryPipelineRun(projectId, current.latestPipeline.id); await load(); } catch (caught) { setError(caught.message); } finally { setBusy(false); } }
  if (!project || !current) return error ? <ErrorState message={error} /> : <LoadingState message="Loading pipeline…" />;
  const status = current.latestPipeline?.status || "not_started";
  const failed = ["failed", "blocked"].includes(current.overallStatus) || status === "cancelled";
  return <div className="workspace-page simple-pipeline-page">
    <header className="project-page-header"><div className="project-title-lockup"><span className="project-glyph project-glyph-large"><AppIcon name="pipeline" size={21} /></span><div><div className="project-title-row"><h1>Pipeline</h1>{current.hasPipelineRun ? <StatusBadge status={status} /> : null}</div><p>{project.name} <span>·</span> {project.targetBranch}</p></div></div><div className="quick-actions">{current.runControls?.canCancel ? <button className="danger-text-button" disabled={busy} onClick={cancel} type="button">Cancel run</button> : null}{failed && current.latestPipeline?.id ? <button className="button" disabled={busy} onClick={retry} type="button">Retry deployment</button> : null}</div></header>
    {error ? <ErrorState message={error} /> : null}
    {!current.hasPipelineRun ? <section className="simple-pipeline-empty panel-flat"><div className="empty-orbit"><AppIcon name="pipeline" size={26} /></div><div><p className="eyebrow">Ready</p><h2>No deployment run yet</h2><p>Start deployment to follow its progress through ten clear steps.</p></div>{current.nextAction?.type === "start_pipeline" ? <button className="button" disabled={busy} onClick={start} type="button">Deploy application</button> : <Link className="button" to={`/projects/${projectId}`}>Continue setup</Link>}</section> : <section className="simple-pipeline-card panel-flat"><div className="compact-section-heading"><div><p className="eyebrow">Latest deployment</p><h2>{current.currentStepLabel}</h2><p>{current.userFacingStatus}</p></div><StatusBadge status={status} /></div><ol className="simple-pipeline-stages">{stages.map((stage, index) => <li className={`simple-pipeline-stage stage-${stage.status}`} key={stage.key}><span className="simple-stage-marker">{stage.status === "passed" ? <AppIcon name="check" size={14} /> : index + 1}</span><div><strong>{stage.label}</strong>{["running", "failed", "paused"].includes(stage.status) && stage.message ? <small>{stage.message}</small> : null}</div><StatusBadge status={stage.status} /></li>)}</ol></section>}
    {failed ? <section className="simple-recovery-card panel-flat"><div><p className="eyebrow">Deployment stopped</p><h2>{current.failedStageLabel || current.currentStepLabel}</h2><p>{current.latestPipeline?.failureMessage || current.blockedBy?.userMessage || "Resolve this deployment step, then retry."}</p></div>{current.runControls?.canRetry ? <button className="button" disabled={busy} onClick={retry} type="button">Retry deployment</button> : null}</section> : null}
  </div>;
}
