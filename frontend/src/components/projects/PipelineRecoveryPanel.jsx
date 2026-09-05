import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getTroubleshootingSession, getTroubleshootingSessions, startTroubleshooting } from "../../api/platformApi.js";
import ErrorState from "../common/ErrorState.jsx";
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

function FailureDiagnosis({ diagnosis, operation, projectId }) {
  if (!diagnosis) return null;
  return <section className="pipeline-failure-diagnosis" aria-label="Deployment failure diagnosis">
    <div className="compact-section-heading"><div><p className="eyebrow">Deployment failed</p><h3>{diagnosis.summary}</h3></div><StatusBadge status={diagnosis.confidence === "UNVERIFIED" ? "warning" : "failed"} /></div>
    <p><strong>{ownershipLabel(diagnosis)}</strong></p>
    <div className="pipeline-failure-authority"><span><strong>Affected component</strong>{diagnosis.affectedComponent}</span><span><strong>Root cause</strong>{diagnosis.rootCauseCode}</span><span><strong>Retry same commit</strong>{diagnosis.retryDecision === "SAFE_NOW" ? "Supported" : "Not recommended"}</span></div>
    <p>{diagnosis.technicalReason}</p>
    <h4>How to fix</h4><ol className="remediation-list">{diagnosis.remediationSteps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}</ol>
    <p className="state warning"><strong>Next action:</strong> {retryLabel(diagnosis)}</p>
    {diagnosis.completedStages?.length ? <div><h4>Completed successfully</h4><ul>{diagnosis.completedStages.map((stage) => <li key={stage.stage}>{stage.label}</li>)}</ul></div> : null}
    <div className="button-row"><a className="text-link" href={`#failure-evidence-${operation.id}`}>View relevant logs</a>{operation.workflowUrl ? <a className="text-link" href={operation.workflowUrl} rel="noreferrer" target="_blank">View full GitHub Actions logs</a> : null}<Link className="text-link" to={`/projects/${projectId}/troubleshooting?operation=${operation.id}&analyze=1`}>Ask AI</Link></div>
  </section>;
}

export default function PipelineRecoveryPanel({ operations = [], projectId, refreshVersion }) {
  const [provider, setProvider] = useState(null);
  const [operationId, setOperationId] = useState("");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    try {
      const sessions = await getTroubleshootingSessions(projectId);
      const next = operations;
      const failures = next.filter((operation) => operation.aiAnalysisEligible);
      setProvider(sessions.provider || null);
      setOperationId((current) => failures.some((operation) => operation.id === current) ? current : failures[0]?.id || "");
    } catch (caught) { setError(caught.message); }
  }

  const hasEligibleFailure = operations.some((operation) => operation.aiAnalysisEligible);
  useEffect(() => {
    if (!hasEligibleFailure) {
      setProvider(null);
      setOperationId("");
      return;
    }
    void load();
  }, [hasEligibleFailure, operations, projectId, refreshVersion]);
  const selected = operations.find((operation) => operation.id === operationId) || null;

  async function analyze() {
    if (!selected || busy) return;
    setBusy(true); setError("");
    try {
      const created = await startTroubleshooting(projectId, selected.id);
      const session = await getTroubleshootingSession(projectId, created.session.id);
      setResult(session.results?.[0] || null);
      await load();
    } catch (caught) { setError(caught.message); }
    finally { setBusy(false); }
  }

  return <section className="panel-flat pipeline-recovery-panel">
    <div className="compact-section-heading"><div><p className="eyebrow">Recovery</p><h2>Failed-operation recovery</h2><p className="muted">Retry and troubleshooting actions appear only for eligible failed operations.</p></div></div>
    {error ? <ErrorState message={error} onRetry={load} /> : null}
    {operations.length ? <div className="active-run-list">{operations.map((operation) => <article className="active-run-item" data-operation-status={operation.status} key={operation.id}>
      <span className="active-run-identity"><strong>Attempt {operation.attempt} · {operationLabel(operation)}</strong><small>{["failed", "dispatch_failed"].includes(operation.status) ? operation.failedStageLabel || operation.stageLabel || "Deployment failed" : operation.stageLabel || "Waiting for GitHub Actions"}</small></span>
      <span className="button-row">{operation.workflowUrl ? <a className="text-link" href={operation.workflowUrl} rel="noreferrer" target="_blank">View GitHub Actions run</a> : null}{operation.aiAnalysisEligible ? <Link className="text-link" to={`/projects/${projectId}/troubleshooting?operation=${operation.id}&analyze=1`}>Analyze failure</Link> : null}</span>
      {["failed", "dispatch_failed"].includes(operation.status) && operation.errorMessage ? <p className="state error">{operation.errorMessage}</p> : null}
      {operation.dispatchFailure ? <p className="muted">GitHub Actions run was not created; this is DeployGuard dispatch evidence.</p> : null}
      <FailureDiagnosis diagnosis={operation.diagnosis} operation={operation} projectId={projectId} />
      {["failed", "dispatch_failed"].includes(operation.status) ? <div className="pipeline-failure-authority"><span><strong>Service</strong>{operation.failureServiceName || "Project operation"}</span><span><strong>Failure source</strong>{operation.failureOwner === "REPOSITORY_APPLICATION" ? "Repository / application" : operation.failureOwner === "DEPLOYGUARD_PLATFORM" ? "DeployGuard platform" : operation.failureOwner === "EXTERNAL_PROVIDER" ? `External provider — ${operation.externalProvider || "other"}` : "Unverified"}</span><span><strong>Code</strong>{operation.failureCode || "DG_FAILURE_UNVERIFIED"}</span></div> : null}
      {["failed", "dispatch_failed"].includes(operation.status) ? <details className="pipeline-safe-evidence" id={`failure-evidence-${operation.id}`}><summary>Sanitized failure evidence</summary><pre>{operation.safeLog || operation.errorMessage || "No failed-job log was available. The failure stage and workflow link above are the available evidence."}</pre>{operation.advancedSafeLog ? <details><summary>Advanced sanitized workflow log</summary><pre>{operation.advancedSafeLog}</pre></details> : null}</details> : null}
    </article>)}</div> : <p className="muted">No deployment request has been made yet.</p>}
    <section className="pipeline-ai-panel" id="ai-troubleshooting">
      <p className="eyebrow">AI troubleshooting</p><h3>Evidence-bounded failure guidance</h3>
      {selected ? <><label className="field"><span>Failed operation</span><select onChange={(event) => setOperationId(event.target.value)} value={operationId}>{operations.filter((operation) => operation.aiAnalysisEligible).map((operation) => <option key={operation.id} value={operation.id}>Attempt {operation.attempt} · {operation.failedStageLabel || operation.stageLabel || "Deployment failed"}</option>)}</select></label><button className="secondary-button" disabled={busy} onClick={analyze} type="button">{busy ? "Analyzing…" : provider?.configured ? "Analyze failure" : "Analyze available evidence"}</button></> : <p className="muted">AI troubleshooting requires a failed deployment attempt with sanitized persisted evidence.</p>}
      {selected && !provider?.configured ? <p className="muted">{provider?.message || "AI provider status is unavailable."}</p> : null}
      {result ? <section className="pipeline-ai-result"><div className="compact-section-heading"><div><h3>{result.summary}</h3><p>{result.rootCause}</p></div><StatusBadge status={result.resultMode} /></div><p>{result.technicalDetails}</p><ol className="remediation-list">{result.remediationSteps.map((step) => <li key={step}>{step}</li>)}</ol><p className="muted">Confidence {Math.round(Number(result.confidence) * 100)}% · {result.limitations}</p></section> : null}
    </section>
  </section>;
}
