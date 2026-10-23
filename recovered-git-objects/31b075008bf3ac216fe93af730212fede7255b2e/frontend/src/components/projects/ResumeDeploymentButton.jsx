import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { getRecoveryResumePreview, resumeProjectRecovery } from "../../api/projectApi.js";
import { useProductMode } from "../../hooks/useProductMode.js";

const labels = {
  repo_clone: "repository checkout",
  stack_detection: "stack detection",
  preflight: "deployment checks",
  dockerfile_generation: "container setup",
  docker_build: "image build",
  security_scan: "security scan",
  ecr_push: "image publishing",
  terraform_plan: "infrastructure plan",
  terraform_apply: "infrastructure update",
  database_tier_setup: "database setup",
  ecs_task_definition_update: "application configuration",
  ecs_service_deploy: "ECS redeploy",
  health_check: "health check",
  stable_release: "stable release",
  cleanup_inventory: "resource inventory",
  cleanup_safe_leftovers: "safe cleanup",
};

function stageLabel(stage, developerMode) {
  return developerMode ? stage : labels[stage] || "deployment recovery";
}

function actionLabel(issue) {
  if (issue?.code === "project_configuration_changed") return "Generate a new Terraform plan";
  return /build|security|ecr|terraform|ecs|health/i.test(issue?.resumeFromStage || "")
    ? "Retry failed stage"
    : "Resume fix";
}

export default function ResumeDeploymentButton({ issue, projectId }) {
  const navigate = useNavigate();
  const { isDeveloperMode } = useProductMode();
  const [decision, setDecision] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  if (!projectId || (!issue?.canResume && !issue?.requiresFullRerun && issue?.category !== "cleanup")) return null;

  async function preview() {
    setBusy("preview"); setError("");
    try { setDecision((await getRecoveryResumePreview(projectId, issue.code)).decision); }
    catch (caught) { setError(caught.message); }
    finally { setBusy(""); }
  }

  async function resume() {
    setBusy("resume"); setError("");
    try {
      const response = await resumeProjectRecovery(projectId, issue.code);
      const runId = response.newRunId || response.pipelineRun?.id;
      navigate(runId ? `/projects/${projectId}/pipeline?runId=${encodeURIComponent(runId)}` : response.actionRoute || `/projects/${projectId}/pipeline`);
    } catch (caught) { setError(caught.message); }
    finally { setBusy(""); }
  }

  async function generateTerraformPlan() {
    setBusy("preview"); setError("");
    try {
      const nextDecision = (await getRecoveryResumePreview(projectId, issue.code)).decision;
      if (nextDecision?.mode !== "resume") {
        setError(nextDecision?.fallbackReason || "A selective Terraform-plan retry is not safe. Use Full redeploy under Advanced options.");
        return;
      }
      const stages = nextDecision?.rerunStages?.filter((stage) => isDeveloperMode || !["terraform_apply"].includes(stage));
      const path = stages?.map((stage) => stageLabel(stage, isDeveloperMode)).join(" → ");
      if (!window.confirm(`DeployGuard will resume from: ${path}`)) return;
      setDecision(nextDecision);
      await resume();
    } catch (caught) { setError(caught.message); }
    finally { setBusy(""); }
  }

  const visibleStages = decision?.rerunStages?.filter((stage) => isDeveloperMode || !["terraform_plan", "terraform_apply"].includes(stage));
  const sequence = visibleStages?.map((stage) => stageLabel(stage, isDeveloperMode)).join(" → ");
  return <div className="recovery-resume-control">
    {(issue.canResume || issue.category === "cleanup") && !decision ? <button className="secondary-button" disabled={Boolean(busy)} onClick={issue.code === "project_configuration_changed" ? generateTerraformPlan : preview} type="button">{busy ? "Checking checkpoints…" : actionLabel(issue)}</button> : null}{decision && issue.code !== "project_configuration_changed" ? <div className="recovery-resume-confirmation">
      <strong>{decision.mode === "full" ? "A full redeploy is required" : "Confirm recovery resume"}</strong>
      <p>{decision.mode === "full" ? decision.fallbackReason : `DeployGuard will resume from: ${sequence}`}</p>
      {decision.mode === "resume" ? <><p className="muted">Earlier matching stages will be shown as “Reused from previous successful run.”</p><div className="quick-actions"><button className="button" disabled={Boolean(busy)} onClick={resume} type="button">{busy === "resume" ? "Queuing…" : "Confirm resume"}</button><button className="subtle-button" disabled={Boolean(busy)} onClick={() => setDecision(null)} type="button">Cancel</button></div></> : null}
      {decision.mode === "cleanup" ? <div className="quick-actions"><button className="button" disabled={Boolean(busy)} onClick={resume} type="button">Open cleanup</button><button className="subtle-button" onClick={() => setDecision(null)} type="button">Cancel</button></div> : null}
    </div> : null}
    {error ? <p className="inline-action-error" role="alert">{error}</p> : null}
    {issue.category !== "cleanup" ? <details className="recovery-advanced-options"><summary>Execution availability</summary><p>Legacy full redeploy is retired. Use the guarded v1 lifecycle when the project is eligible.</p></details> : null}
  </div>;
}
