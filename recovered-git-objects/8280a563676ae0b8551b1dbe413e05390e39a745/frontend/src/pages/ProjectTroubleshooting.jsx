import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { followUpTroubleshooting, getTroubleshootingSession, getTroubleshootingSessions, startTroubleshooting } from "../api/platformApi.js";
import { getProjectCurrentState } from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { PageHeader, StatusBadge } from "../components/common/Premium.jsx";

export default function ProjectTroubleshooting() {
  const { projectId } = useParams(); const [query] = useSearchParams();
  const [sessions, setSessions] = useState([]); const [selected, setSelected] = useState(null); const [current, setCurrent] = useState(null); const [provider, setProvider] = useState(null); const [message, setMessage] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function load() { try { const [list, state] = await Promise.all([getTroubleshootingSessions(projectId), getProjectCurrentState(projectId)]); setSessions(list.items || []); setProvider(list.provider || null); setCurrent(state); const requested = query.get("session") || list.items?.[0]?.id; if (requested) setSelected(await getTroubleshootingSession(projectId, requested)); } catch (caught) { setError(caught.message); } }
  useEffect(() => { load(); }, [projectId]);
  async function analyze() { const runId = current?.latestPipeline?.id; if (!runId) return; setBusy(true); try { const created = await startTroubleshooting(projectId, runId); setSelected(await getTroubleshootingSession(projectId, created.session.id)); await load(); } catch (caught) { setError(caught.message); } finally { setBusy(false); } }
  async function send(event) { event.preventDefault(); if (!selected || !message.trim()) return; setBusy(true); try { await followUpTroubleshooting(projectId, selected.session.id, message); setMessage(""); setSelected(await getTroubleshootingSession(projectId, selected.session.id)); } catch (caught) { setError(caught.message); } finally { setBusy(false); } }
  if (!current) return error ? <ErrorState message={error} /> : <LoadingState message="Loading troubleshooting…" />;
  const result = selected?.results?.[0];
  return <div className="workspace-page">
    <PageHeader eyebrow="AI troubleshooting" title="Deployment diagnosis" description="Evidence-bound guidance from sanitized pipeline, infrastructure, security, and optional runtime records." context={selected ? `Session ${selected.session.id.slice(0, 8)}` : "No analysis yet"} />
    {error ? <ErrorState message={error} /> : null}
    <section className="panel-flat troubleshooting-command"><div><h2>{result ? result.summary : provider?.configured ? "Analyze the latest deployment" : provider?.disabledByConfiguration ? "AI troubleshooting disabled" : "AI troubleshooting not configured"}</h2><p>{result ? result.rootCause : provider?.configured ? "DeployGuard sends only sanitized deployment evidence to the configured provider." : provider?.message || "AI assistant is not configured."}</p></div><button className="button" disabled={busy || !current.latestPipeline?.id || !provider?.configured} onClick={analyze}>Analyze latest run</button></section>
    {result ? <><section className="panel-flat"><div className="compact-section-heading"><div><p className="eyebrow">Diagnosis</p><h2>Recommended recovery</h2></div><StatusBadge status={result.resultMode} /></div><p>{result.technicalDetails}</p><ol className="remediation-list">{result.remediationSteps.map((step) => <li key={step}>{step}</li>)}</ol><p className="muted">Confidence {Math.round(Number(result.confidence) * 100)}% · {result.limitations}</p>{result.evidenceReferences?.length ? <div className="evidence-reference-list">{result.evidenceReferences.map((reference, index) => <Link className="subtle-button" key={`${reference.eventId || reference.source}-${index}`} to={`/projects/${projectId}/logs?run=${encodeURIComponent(selected.session.pipelineRunId)}&event=${encodeURIComponent(reference.eventId || "")}`}>{reference.stage || reference.source || `Evidence ${index + 1}`}</Link>)}</div> : null}</section><form className="panel-flat troubleshooting-followup" onSubmit={send}><label className="field"><span>Ask a follow-up about this evidence</span><textarea maxLength="1000" onChange={(event) => setMessage(event.target.value)} value={message} /></label><button className="secondary-button" disabled={busy || message.trim().length < 2}>Send follow-up</button></form></> : null}
    {sessions.length ? <section className="panel-flat"><p className="eyebrow">History</p><div className="session-list">{sessions.map((session) => <button className="subtle-button" key={session.id} onClick={async () => setSelected(await getTroubleshootingSession(projectId, session.id))}>{session.id.slice(0, 8)} · {session.providerMode}</button>)}</div></section> : null}
  </div>;
}
