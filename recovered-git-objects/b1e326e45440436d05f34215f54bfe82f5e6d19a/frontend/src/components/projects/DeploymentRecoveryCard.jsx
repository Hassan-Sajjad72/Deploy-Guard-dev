import { Link } from "react-router-dom";
import DeveloperDetailsAccordion from "./DeveloperDetailsAccordion.jsx";
import IssueEvidenceList from "./IssueEvidenceList.jsx";
import ResumeDeploymentButton from "./ResumeDeploymentButton.jsx";

export default function DeploymentRecoveryCard({ issue, projectId }) {
  if (!issue) return null;
  const configurationIssue = issue.category === "database" || /missing_(?:runtime|build_time)_env/.test(issue.code || "") || String(issue.primaryActionRoute || "").includes("/requirements");
  return <section className={`panel-flat deployment-recovery-card severity-${issue.severity}`}>
    <div className="deployment-recovery-card-heading"><div><p className="eyebrow">Recovery</p><h2>{issue.title}</h2></div><span className="recovery-severity">{issue.severity}</span></div>
    <p className="recovery-simple-explanation">{issue.simpleExplanation}</p>
    <IssueEvidenceList evidence={issue.detectedEvidence} />
    <p className="recovery-required-action"><strong>Required action</strong>{issue.requiredAction}</p>
    {configurationIssue ? null : <ResumeDeploymentButton issue={issue} projectId={projectId} />}
    <div className="quick-actions"><Link className="button" to={configurationIssue ? `/projects/${projectId}/requirements?focus=${issue.category === "database" ? "database" : "secrets"}` : issue.primaryActionRoute}>{configurationIssue ? "Complete deployment requirements" : issue.primaryActionLabel}</Link></div>
    <DeveloperDetailsAccordion details={issue.developerDetails} />
  </section>;
}
