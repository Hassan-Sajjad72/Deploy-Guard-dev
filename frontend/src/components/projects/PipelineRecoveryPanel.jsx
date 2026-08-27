import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getTroubleshootingSession, getTroubleshootingSessions, startTroubleshooting } from "../../api/platformApi.js";
import ErrorState from "../common/ErrorState.jsx";
import { StatusBadge } from "../common/Premium.jsx";

function operationLabel(operation) {
  if (operation.status === "completed") return "Live";
  if (operation.status === "failed") return "Failed";
  return String(operation.status || "queued").replaceAll("_", " ");
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
    <div className="compact-section-heading"><div><p className="eyebrow">Pipeline & recovery</p><h2>Deployment attempts</h2><p className="muted">GitHub Actions is the source of truth. Failure evidence is sanitized before it is shown or analyzed.</p></div></div>
    {error ? <ErrorState message={error} onRetry={load} /> : null}
    {operations.length ? <div className="active-run-list">{operations.map((operation) => <article className="active-run-item" data-operation-status={operation.status} key={operation.id}>
      <span className="active-run-identity"><strong>Attempt {operation.attempt} · {operationLabel(operation)}</strong><small>{operation.status === "failed" ? operation.failedStageLabel || operation.stageLabel || "Deployment failed" : operation.stageLabel || "Waiting for GitHub Actions"}</small></span>
      <span className="button-row">{operation.workflowUrl ? <a className="text-link" href={operation.workflowUrl} rel="noreferrer" target="_blank">View GitHub Actions run</a> : null}{operation.aiAnalysisEligible ? <Link className="text-link" to="#ai-troubleshooting" onClick={() => setOperationId(operation.id)}>Analyze failure</Link> : null}</span>
      {operation.status === "failed" && operation.errorMessage ? <p className="state error">{operation.errorMessage}</p> : null}
      {operation.status === "failed" ? <details className="pipeline-safe-evidence"><summary>Safe GitHub Actions evidence</summary><pre>{operation.safeLog || "No failed-job log was available. The failure stage and workflow link above are the available evidence."}</pre>{operation.advancedSafeLog ? <details><summary>Advanced sanitized workflow log</summary><pre>{operation.advancedSafeLog}</pre></details> : null}</details> : null}
    </article>)}</div> : <p className="muted">No GitHub Actions deployment has started yet.</p>}
    <section className="pipeline-ai-panel" id="ai-troubleshooting">
      <p className="eyebrow">AI troubleshooting</p><h3>Evidence-bounded failure guidance</h3>
      {selected ? <><label className="field"><span>Failed operation</span><select onChange={(event) => setOperationId(event.target.value)} value={operationId}>{operations.filter((operation) => operation.aiAnalysisEligible).map((operation) => <option key={operation.id} value={operation.id}>Attempt {operation.attempt} · {operation.failedStageLabel || operation.stageLabel || "Deployment failed"}</option>)}</select></label><button className="secondary-button" disabled={busy || !provider?.configured} onClick={analyze} type="button">{busy ? "Analyzing…" : "Analyze failure"}</button></> : <p className="muted">AI troubleshooting requires a failed GitHub Actions operation with sanitized persisted evidence.</p>}
      {selected && !provider?.configured ? <p className="muted">{provider?.message || "AI provider status is unavailable."}</p> : null}
      {result ? <section className="pipeline-ai-result"><div className="compact-section-heading"><div><h3>{result.summary}</h3><p>{result.rootCause}</p></div><StatusBadge status={result.resultMode} /></div><p>{result.technicalDetails}</p><ol className="remediation-list">{result.remediationSteps.map((step) => <li key={step}>{step}</li>)}</ol><p className="muted">Confidence {Math.round(Number(result.confidence) * 100)}% · {result.limitations}</p></section> : null}
    </section>
  </section>;
}
