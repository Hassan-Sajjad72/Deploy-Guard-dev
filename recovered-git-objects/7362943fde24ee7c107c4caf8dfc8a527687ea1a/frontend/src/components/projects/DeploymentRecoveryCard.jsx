import { Link } from "react-router-dom";
import DeveloperDetailsAccordion from "./DeveloperDetailsAccordion.jsx";
import IssueEvidenceList from "./IssueEvidenceList.jsx";
import ResumeDeploymentButton from "./ResumeDeploymentButton.jsx";

const resumeLabels = {
  repo_clone: "repository analysis",
  stack_detection: "stack detection",
  preflight: "deployment checks",
  docker_build: "image build",
  security_scan: "security review",
  ecr_push: "image publishing",
  terraform_plan: "infrastructure planning",
  state_recovery: "infrastructure state recovery",
  database_tier_setup: "database setup",
  storage_setup: "storage setup",
  ecs_task_definition: "application configuration",
  alb_health: "health verification",
  cleanup_inventory: "resource inventory",
};

export default function DeploymentRecoveryCard({ issue, projectId, readOnly = false, showResume = false }) {
  if (!issue) return null;
  const configurationIssue = issue.category === "database" || /missing_(?:runtime|build_time)_env/.test(issue.code || "") || String(issue.primaryActionRoute || "").includes("/requirements");
  const executableRecovery = !configurationIssue && issue.canResume && issue.primaryActionMode === "recovery_center";
  return <section className={`panel-flat deployment-recovery-card severity-${issue.severity}`}>
    <div className="deployment-recovery-card-heading"><div><p className="eyebrow">Recovery</p><h2>{issue.title}</h2></div><span className="recovery-severity">{issue.severity}</span></div>
    <p className="recovery-simple-explanation">{issue.simpleExplanation}</p>
    <IssueEvidenceList evidence={issue.detectedEvidence} />
    <p className="recovery-required-action"><strong>Required action</strong>{issue.requiredAction}</p>
    <p className="recovery-resume-note">{issue.category === "cleanup" ? "This action refreshes cleanup inventory without starting a deployment." : issue.requiresFullRerun ? "Source or build inputs changed, so deployment must restart from repository analysis." : issue.canResume ? `After the fix, DeployGuard can continue from ${resumeLabels[issue.resumeFromStage] || "the affected deployment step"}.` : "DeployGuard will verify the fix before offering a retry."}</p>
    {readOnly ? <p className="recovery-resume-note">Recovery evidence is read-only on Overview. Use the operator workspace for any controlled recovery action.</p> : null}
    {!readOnly && (showResume || executableRecovery) && !configurationIssue ? <ResumeDeploymentButton issue={issue} projectId={projectId} /> : null}
    {!readOnly && !executableRecovery ? <div className="quick-actions"><Link className="button" to={configurationIssue ? `/projects/${projectId}/requirements?focus=${issue.category === "database" ? "database" : "secrets"}` : issue.primaryActionRoute}>{configurationIssue ? "Complete deployment requirements" : issue.primaryActionLabel}</Link></div> : null}
    <DeveloperDetailsAccordion details={issue.developerDetails} />
  </section>;
}
