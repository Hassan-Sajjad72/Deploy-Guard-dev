import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { followUpTroubleshooting, getTroubleshootingSession, getTroubleshootingSessions, startTroubleshooting } from "../api/platformApi.js";
import { getGithubActionsDeploymentHistory } from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { PageHeader, StatusBadge } from "../components/common/Premium.jsx";

export default function ProjectTroubleshooting() {
  const { projectId } = useParams();
  const [query] = useSearchParams();
  const [sessions, setSessions] = useState([]);
  const [failedOperations, setFailedOperations] = useState([]);
  const [operationId, setOperationId] = useState("");
  const [selected, setSelected] = useState(null);
  const [provider, setProvider] = useState(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  async function load() {
    setError("");
    try {
      const [list, history] = await Promise.all([
        getTroubleshootingSessions(projectId),
        getGithubActionsDeploymentHistory(projectId),
      ]);
      const failures = (history.operations || []).filter((operation) => operation.status === "failed" && operation.workflowRunId);
      setSessions(list.items || []);
      setProvider(list.provider || null);
      setFailedOperations(failures);
      setOperationId((current) => current || failures[0]?.id || "");
      const requested = query.get("session") || list.items?.[0]?.id;
      if (requested) setSelected(await getTroubleshootingSession(projectId, requested));
    } catch (caught) {
      setError(caught.message);
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => { void load(); }, [projectId]);

  async function analyze() {
    if (!operationId) return;
    setBusy(true); setError("");
    try {
      const created = await startTroubleshooting(projectId, operationId);
      setSelected(await getTroubleshootingSession(projectId, created.session.id));
      await load();
    } catch (caught) { setError(caught.message); }
    finally { setBusy(false); }
  }

  async function send(event) {
    event.preventDefault();
    if (!selected || !message.trim()) return;
    setBusy(true); setError("");
    try {
      await followUpTroubleshooting(projectId, selected.session.id, message);
      setMessage("");
      setSelected(await getTroubleshootingSession(projectId, selected.session.id));
    } catch (caught) { setError(caught.message); }
    finally { setBusy(false); }
  }

  if (!loaded) return <LoadingState message="Loading troubleshooting…" />;
  const result = selected?.results?.[0];
  const operation = failedOperations.find((item) => item.id === operationId);

  return <div className="workspace-page">
    <PageHeader eyebrow="AI troubleshooting" title="GitHub Actions failure diagnosis" description="Evidence-bounded guidance from synchronized, sanitized GitHub Actions failure logs only." context={selected ? `Session ${selected.session.id.slice(0, 8)}` : "No analysis yet"} />
    {error ? <ErrorState message={error} /> : null}
    <section className="panel-flat troubleshooting-command">
      <div>
        <h2>{result ? result.summary : failedOperations.length ? "Analyze a failed operation" : "No failed GitHub Actions operation"}</h2>
        <p>{result ? result.rootCause : failedOperations.length ? "Select a historical failure. DeployGuard will not diagnose successful or active operations." : "Troubleshooting becomes available after a GitHub Actions operation truthfully fails."}</p>
        {operation?.safeLog ? <p className="muted">Sanitized failure evidence is available for workflow run {operation.workflowRunId}.</p> : operation ? <p className="muted">Evidence is limited; any result must state that a root cause cannot be established.</p> : null}
      </div>
      <div className="field">
        <span>Failed operation</span>
        <select onChange={(event) => setOperationId(event.target.value)} value={operationId}>
          {failedOperations.map((item) => <option key={item.id} value={item.id}>Attempt {item.attempt} · {item.failedStageLabel || item.stageLabel || "Deployment failed"}</option>)}
        </select>
        <button className="button" disabled={busy || !operationId || !provider?.configured} onClick={analyze} type="button">{busy ? "Analyzing…" : "Analyze failure"}</button>
        {!provider?.configured ? <small>{provider?.message || "AI provider is not configured."}</small> : null}
      </div>
    </section>
    {result ? <><section className="panel-flat"><div className="compact-section-heading"><div><p className="eyebrow">Diagnosis</p><h2>Recommended recovery</h2></div><StatusBadge status={result.resultMode} /></div><p>{result.technicalDetails}</p><ol className="remediation-list">{result.remediationSteps.map((step) => <li key={step}>{step}</li>)}</ol><p className="muted">Confidence {Math.round(Number(result.confidence) * 100)}% · {result.limitations}</p>{result.evidenceReferences?.length ? <div className="evidence-reference-list">{result.evidenceReferences.map((reference, index) => <Link className="subtle-button" key={`${reference.eventId || reference.source}-${index}`} to={`/projects/${projectId}/pipeline`}>{reference.stage || reference.source || `Evidence ${index + 1}`}</Link>)}</div> : null}</section><form className="panel-flat troubleshooting-followup" onSubmit={send}><label className="field"><span>Ask a follow-up about this evidence</span><textarea maxLength="1000" onChange={(event) => setMessage(event.target.value)} value={message} /></label><button className="secondary-button" disabled={busy || message.trim().length < 2}>Send follow-up</button></form></> : null}
    {sessions.length ? <section className="panel-flat"><p className="eyebrow">History</p><div className="session-list">{sessions.map((session) => <button className="subtle-button" key={session.id} onClick={async () => setSelected(await getTroubleshootingSession(projectId, session.id))}>{session.id.slice(0, 8)} · {session.providerMode}</button>)}</div></section> : null}
  </div>;
}
