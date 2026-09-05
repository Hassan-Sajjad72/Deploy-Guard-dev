import { StatusBadge } from "../common/Premium.jsx";

function operationLabel(operation) {
  if (operation.status === "completed") return "Live";
  if (operation.status === "failed") return "Failed";
  if (operation.status === "dispatch_failed") return "Dispatch failed";
  return String(operation.status || "queued").replaceAll("_", " ");
}

function ownershipLabel(diagnosis) {
  if (diagnosis.failureOwner === "REPOSITORY_APPLICATION") return "Repository / Application issue";
  if (diagnosis.failureOwner === "DEPLOYGUARD_PLATFORM") return "DeployGuard platform issue";
  if (diagnosis.failureOwner === "EXTERNAL_PROVIDER") return `External provider issue${diagnosis.externalProvider ? ` — ${diagnosis.externalProvider}` : ""}`;
  return "Cause not yet verified";
}

function retryLabel(diagnosis) {
  if (diagnosis.retryDecision === "SAFE_NOW") return "Retry is supported by the available evidence.";
  if (diagnosis.retryDecision === "SAFE_AFTER_FIX") return "Do not retry the same immutable commit. Fix the repository condition and deploy the new commit.";
  if (diagnosis.retryDecision === "NOT_SAFE_YET") return "Resolve the reported condition before retrying.";
  return "The available evidence is not sufficient to claim a retry is safe.";
}

function confidenceLabel(confidence) {
  if (confidence === "DETERMINISTIC") return "Deterministic";
  if (confidence === "HIGH") return "High confidence";
  return "Unverified";
}

function retrySummary(retryDecision) {
  if (retryDecision === "SAFE_NOW") return "Safe to retry";
  if (retryDecision === "SAFE_AFTER_FIX") return "Fix before retrying";
  return retryDecision === "NOT_SAFE_YET" ? "Resolve before retrying" : "Insufficient evidence";
}

function FailureDiagnosis({ diagnosis, operation }) {
  if (!diagnosis) return null;
  return <section className="pipeline-failure-diagnosis" aria-label="Deployment failure diagnosis">
    <div className="compact-section-heading"><div><p className="eyebrow">DeployGuard diagnosis</p><h3>{diagnosis.summary}</h3></div><StatusBadge status={diagnosis.confidence === "UNVERIFIED" ? "warning" : "failed"}>{confidenceLabel(diagnosis.confidence)}</StatusBadge></div>
    <p><strong>{ownershipLabel(diagnosis)}</strong></p>
    <div className="pipeline-failure-authority"><span><strong>Affected component</strong>{diagnosis.affectedComponent}</span><span><strong>Root cause</strong>{diagnosis.rootCauseCode}</span><span><strong>Retry</strong>{retrySummary(diagnosis.retryDecision)}</span></div>
    <p>{diagnosis.technicalReason}</p>
    <h4>How to fix</h4><ol className="remediation-list">{diagnosis.remediationSteps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}</ol>
    <p className="state warning"><strong>Next action:</strong> {retryLabel(diagnosis)}</p>
    {diagnosis.completedStages?.length ? <div><h4>Completed successfully</h4><ul>{diagnosis.completedStages.map((stage) => <li key={stage.stage}>{stage.label}</li>)}</ul></div> : null}
    <div className="button-row"><a className="text-link" href={`#failure-evidence-${operation.id}`}>View relevant logs</a>{operation.workflowUrl ? <a className="text-link" href={operation.workflowUrl} rel="noreferrer" target="_blank">View full GitHub Actions logs</a> : null}</div>
  </section>;
}

export default function PipelineRecoveryPanel({ operations = [] }) {
  return <section className="panel-flat pipeline-recovery-panel">
    <div className="compact-section-heading"><div><p className="eyebrow">Recovery</p><h2>Failed-operation recovery</h2><p className="muted">Review deterministic diagnosis, remediation, retry guidance, and technical evidence for deployment attempts.</p></div></div>
    {operations.length ? <div className="active-run-list">{operations.map((operation) => <article className="active-run-item" data-operation-status={operation.status} key={operation.id}>
      <span className="active-run-identity"><strong>Attempt {operation.attempt} · {operationLabel(operation)}</strong><small>{["failed", "dispatch_failed"].includes(operation.status) ? operation.failedStageLabel || operation.stageLabel || "Deployment failed" : operation.stageLabel || "Waiting for GitHub Actions"}</small></span>
      <span className="button-row">{operation.workflowUrl ? <a className="text-link" href={operation.workflowUrl} rel="noreferrer" target="_blank">View GitHub Actions run</a> : null}</span>
      {["failed", "dispatch_failed"].includes(operation.status) && operation.errorMessage ? <p className="state error">{operation.errorMessage}</p> : null}
      {operation.dispatchFailure ? <p className="muted">GitHub Actions run was not created; this is DeployGuard dispatch evidence.</p> : null}
      <FailureDiagnosis diagnosis={operation.diagnosis} operation={operation} />
      {["failed", "dispatch_failed"].includes(operation.status) ? <div className="pipeline-failure-authority"><span><strong>Service</strong>{operation.diagnosis?.serviceName || operation.failureServiceName || "Project operation"}</span><span><strong>Failure source</strong>{ownershipLabel(operation.diagnosis || operation)}</span><span><strong>Pipeline failure code</strong>{operation.diagnosis?.terminalFailureCode || operation.failureCode || "DG_FAILURE_UNVERIFIED"}</span></div> : null}
      {["failed", "dispatch_failed"].includes(operation.status) ? <details className="pipeline-safe-evidence" id={`failure-evidence-${operation.id}`}><summary>Sanitized failure evidence</summary><pre>{operation.safeLog || operation.errorMessage || "No failed-job log was available. The failure stage and workflow link above are the available evidence."}</pre>{operation.advancedSafeLog ? <details><summary>Advanced sanitized workflow log</summary><pre>{operation.advancedSafeLog}</pre></details> : null}</details> : null}
    </article>)}</div> : <p className="muted">No deployment request has been made yet.</p>}
  </section>;
}
