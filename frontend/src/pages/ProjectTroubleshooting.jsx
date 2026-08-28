import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { followUpTroubleshooting, getTroubleshootingSession, getTroubleshootingSessions, regenerateTroubleshooting, startTroubleshooting } from "../api/platformApi.js";
import { getGithubActionsDeploymentHistory } from "../api/projectApi.js";
import { Card, PageHeader, StatusChip } from "../components/common/DesignSystem.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";

const sourceLabels = { github_actions: "GitHub Actions", github_actions_status: "GitHub Actions", terraform: "Terraform", ecs_cloudwatch_runtime: "ECS / CloudWatch runtime logs", deployguard_lifecycle: "DeployGuard lifecycle evidence" };
function label(value) { return String(value || "Unavailable").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function date(value) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Unavailable"; }

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

  async function load(preferredSession) {
    setError("");
    try {
      const [list, history] = await Promise.all([getTroubleshootingSessions(projectId), getGithubActionsDeploymentHistory(projectId)]);
      const failures = (history.operations || []).filter((operation) => operation.status === "failed" && operation.aiAnalysisEligible === true);
      setSessions(list.items || []); setProvider(list.provider || null); setFailedOperations(failures);
      setOperationId((current) => current || failures[0]?.id || "");
      const requested = preferredSession || query.get("session") || list.items?.[0]?.id;
      if (requested) setSelected(await getTroubleshootingSession(projectId, requested));
    } catch (caught) { setError(caught.message); }
    finally { setLoaded(true); }
  }
  useEffect(() => { void load(); }, [projectId]);

  async function analyze() {
    if (!operationId) return;
    setBusy(true); setError("");
    try { const created = await startTroubleshooting(projectId, operationId); await load(created.session.id); }
    catch (caught) { setError(caught.message); }
    finally { setBusy(false); }
  }
  async function regenerate() {
    if (!selected) return;
    setBusy(true); setError("");
    try { await regenerateTroubleshooting(projectId, selected.session.id); setSelected(await getTroubleshootingSession(projectId, selected.session.id)); }
    catch (caught) { setError(caught.message); }
    finally { setBusy(false); }
  }
  async function send(event) {
    event.preventDefault(); if (!selected || !message.trim()) return;
    setBusy(true); setError("");
    try { await followUpTroubleshooting(projectId, selected.session.id, message); setMessage(""); setSelected(await getTroubleshootingSession(projectId, selected.session.id)); }
    catch (caught) { setError(caught.message); }
    finally { setBusy(false); }
  }

  if (!loaded) return <LoadingState message="Loading troubleshooting evidence…" />;
  const result = selected?.results?.[0];
  const selectedHistoryOperation = failedOperations.find((item) => item.id === operationId);
  const operation = selected?.operation || (selectedHistoryOperation ? { id: selectedHistoryOperation.id, action: selectedHistoryOperation.deploymentAction, commitSha: selectedHistoryOperation.commitSha, generationId: selectedHistoryOperation.generationId, failedStage: selectedHistoryOperation.failedStageLabel || selectedHistoryOperation.stageLabel, failedAt: selectedHistoryOperation.failedAt, summary: selectedHistoryOperation.errorMessage } : null);
  const groups = selected?.evidence?.groups || {};
  const questions = selected?.suggestedQuestions || [];
  const providerStatus = provider?.availability || provider?.mode || "unavailable";

  return <div className="workspace-page troubleshooting-page">
    <PageHeader context={selected ? `Session ${selected.session.id.slice(0, 8)} · Operation ${selected.session.pipelineRunId.slice(0, 8)}` : "Select an eligible failed operation"} description="Evidence from the exact selected project and operation is sanitized, bounded and analyzed without inferring unavailable AWS or GitHub facts." eyebrow="AI troubleshooting" status={result?.resultMode || providerStatus} title="Failure diagnosis" />
    {error ? <ErrorState message={error} onRetry={() => void load(selected?.session?.id)} /> : null}
    <Card className="troubleshooting-command">
      <div><p className="eyebrow">Provider status</p><h2>{provider?.provider ? `${label(provider.provider)} · ${label(providerStatus)}` : "Evidence-only analysis"}</h2><p>{provider?.message || "Provider status is unavailable. Deterministic evidence-only diagnostics remain available."}</p></div>
      <label className="field"><span>Eligible failed operation</span><select onChange={(event) => { setOperationId(event.target.value); setSelected(null); }} value={operationId}>{failedOperations.map((item) => <option key={item.id} value={item.id}>Attempt {item.attempt} · {label(item.deploymentAction)} · {item.failedStageLabel || item.stageLabel}</option>)}</select></label>
      <div className="quick-actions"><button className="button" disabled={busy || !operationId} onClick={analyze} type="button">{busy ? "Analyzing evidence…" : provider?.available ? "Analyze with Gemini" : "Analyze available evidence"}</button>{selected ? <button className="secondary-button" disabled={busy} onClick={regenerate} type="button">Retry analysis</button> : null}</div>
      {!failedOperations.length ? <p className="muted">No failed deployment attempt has sanitized persisted evidence. Insufficient-evidence operations are intentionally excluded.</p> : null}
    </Card>

    {operation ? <Card><div className="compact-section-heading"><div><p className="eyebrow">Selected failure</p><h2>{label(operation.action)} failed</h2></div><StatusChip status="failed">Failed</StatusChip></div><div className="troubleshooting-operation-grid"><article><span>Project</span><strong>{selected?.evidence?.context?.project?.name || "Current project"}</strong></article><article><span>Action</span><strong>{label(operation.action)}</strong></article><article><span>Commit</span><strong>{String(operation.commitSha || "Unavailable").slice(0, 12)}</strong></article><article><span>Generation</span><strong>{String(operation.generationId || "Unavailable").slice(0, 12)}</strong></article><article><span>Failed stage</span><strong>{label(operation.failedStage)}</strong></article><article><span>Timestamp</span><strong>{date(operation.failedAt)}</strong></article></div><p className="troubleshooting-failure-summary">{operation.summary || result?.summary || "The persisted operation contains failure evidence without a separate summary."}</p></Card> : null}

    {result ? <Card className="troubleshooting-diagnosis"><div className="compact-section-heading"><div><p className="eyebrow">Diagnosis</p><h2>{result.summary}</h2></div><StatusChip status={result.resultMode === "live" ? "healthy" : "warning"}>{result.resultMode === "live" ? "Gemini" : "Evidence-only fallback"}</StatusChip></div><section><h3>Root Cause</h3><p>{result.rootCause}</p></section><section><h3>Technical Details</h3><p>{result.technicalDetails}</p></section><section><h3>Recommended Fix</h3><ol className="remediation-list">{result.remediationSteps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}</ol></section><p className="muted">Confidence {Math.round(Number(result.confidence) * 100)}% · {result.limitations}</p>{result.evidenceReferences?.length ? <div><h3>Evidence references</h3><div className="evidence-reference-list">{result.evidenceReferences.map((reference, index) => <Link className="subtle-button" key={`${reference.eventId || reference.source}-${index}`} to={`/projects/${projectId}/pipeline`}>{sourceLabels[reference.source] || label(reference.source)} · {label(reference.stage)}</Link>)}</div></div> : null}</Card> : null}

    {selected ? <Card><div><p className="eyebrow">Evidence viewer</p><h2>Sanitized operation evidence</h2><p>Raw evidence is grouped and collapsed by default. Every item belongs to operation {selected.session.pipelineRunId.slice(0, 8)}.</p></div><div className="troubleshooting-evidence-groups">{Object.entries(groups).map(([source, items]) => <details key={source}><summary>{sourceLabels[source] || label(source)} <span>{items.length} item{items.length === 1 ? "" : "s"}</span></summary><ol>{items.map((item, index) => <li key={item.eventId || index}><div><strong>{label(item.stage)}</strong><time>{date(item.timestamp)}</time></div><pre>{item.text}</pre></li>)}</ol></details>)}</div></Card> : null}

    {selected ? <Card className="troubleshooting-chat"><div><p className="eyebrow">Follow-up assistant</p><h2>Ask about this operation</h2><p>The most recent bounded session messages and the same immutable evidence are used for every answer.</p></div><div className="troubleshooting-chat-history">{selected.messages?.length ? selected.messages.map((item) => <article data-role={item.role} key={item.id}><strong>{item.role === "user" ? "You" : "DeployGuard"}</strong><p>{item.content}</p></article>) : <p className="muted">Ask a follow-up after reviewing the diagnosis.</p>}</div><form className="troubleshooting-followup" onSubmit={send}><label className="field"><span>Follow-up question</span><textarea maxLength="1000" onChange={(event) => setMessage(event.target.value)} value={message} /></label>{questions.length ? <div className="quick-actions">{questions.map((question) => <button className="subtle-button" key={question} onClick={() => setMessage(question)} type="button">{question}</button>)}</div> : null}<button className="secondary-button" disabled={busy || message.trim().length < 2}>{busy ? "Working…" : "Send follow-up"}</button></form></Card> : null}
    {sessions.length ? <Card><p className="eyebrow">Analysis history</p><div className="session-list">{sessions.map((session) => <button className="subtle-button" key={session.id} onClick={async () => setSelected(await getTroubleshootingSession(projectId, session.id))}>{session.id.slice(0, 8)} · {label(session.providerMode)} · {date(session.updatedAt)}</button>)}</div></Card> : null}
  </div>;
}
