import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { followUpTroubleshooting, getTroubleshootingSession, getTroubleshootingSessions, regenerateTroubleshooting, startTroubleshooting } from "../api/platformApi.js";
import { getGithubActionsDeploymentHistory, getProjectCurrentState } from "../api/projectApi.js";
import { Card, EmptyState, PageHeader, StatusChip } from "../components/common/DesignSystem.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { redirectDeletedProject, subscribeProjectStateChanged } from "../utils/projectStateSync.js";
import { projectStatePresentation } from "../utils/projectStatePresentation.js";
import { failureTroubleshootingProjection } from "../utils/developerDeploymentPresentation.js";

const sourceLabels = { github_actions: "GitHub Actions", github_actions_status: "GitHub Actions", github_actions_stage: "GitHub Actions stages", railpack_build: "Application build evidence", deployguard_build_identity: "Service / build identity", deployguard_diagnosis: "DeployGuard diagnosis", security_scan: "Trivy security scan", terraform: "Terraform", aws_runtime_verification: "AWS runtime verification", cloudwatch_runtime: "CloudWatch application logs", ecs_cloudwatch_runtime: "ECS / CloudWatch runtime events", deployguard_lifecycle: "DeployGuard lifecycle evidence" };
function label(value) { return String(value || "Unavailable").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function date(value) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Unavailable"; }
function generation(value) { return value ? String(value).slice(0, 12) : "Not created — deployment failed before runtime generation."; }
function operationTimestamp(operation) { return operation?.failedAt || operation?.completedAt || operation?.startedAt || operation?.createdAt || null; }

export default function ProjectTroubleshooting() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [query] = useSearchParams();
  const [sessions, setSessions] = useState([]);
  const [eligibleOperations, setEligibleOperations] = useState([]);
  const [operationId, setOperationId] = useState("");
  const [selected, setSelected] = useState(null);
  const [provider, setProvider] = useState(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [currentState, setCurrentState] = useState(null);
  const [selectedServiceId, setSelectedServiceId] = useState("");
  const [questionType, setQuestionType] = useState(null);
  const automaticAnalysisStarted = useRef(false);

  const load = useCallback(async (preferredSession) => {
    setError("");
    try {
      const [list, history, state] = await Promise.all([getTroubleshootingSessions(projectId), getGithubActionsDeploymentHistory(projectId), getProjectCurrentState(projectId)]);
      const projection = failureTroubleshootingProjection(history.operations || [], list.items || []);
      const candidates = projection.candidates;
      const failureSessions = projection.sessions;
      const requestedOperation = query.get("operation");
      const requestedSession = [preferredSession, query.get("session")]
        .map((sessionId) => failureSessions.find((session) => session.id === sessionId))
        .find(Boolean);
      const selectedOperationId = requestedOperation && candidates.some((item) => item.id === requestedOperation)
        ? requestedOperation
        : requestedSession?.pipelineRunId || (projectStatePresentation(state).state === "FAILED" ? candidates[0]?.id || "" : "");
      const runtimeServices = Array.isArray(state.infrastructureEvidence?.runtimeIdentity?.services) ? state.infrastructureEvidence.runtimeIdentity.services : [];
      setSessions(failureSessions); setProvider(list.provider || null); setEligibleOperations(candidates); setCurrentState(state);
      setOperationId(selectedOperationId);
      setSelectedServiceId((current) => runtimeServices.some((service) => service.serviceId === current) ? current : runtimeServices[0]?.serviceId || "");
      const existingForOperation = requestedOperation ? failureSessions.find((session) => session.pipelineRunId === requestedOperation)?.id : null;
      const requested = [preferredSession, query.get("session"), existingForOperation]
        .find((sessionId) => sessionId && failureSessions.some((session) => session.id === sessionId));
      setSelected(requested ? await getTroubleshootingSession(projectId, requested) : null);
    } catch (caught) { if (!redirectDeletedProject(caught, navigate)) setError(caught.message); }
    finally { setLoaded(true); }
  }, [navigate, projectId, query]);
  useEffect(() => { void load(); }, [load, projectId]);
  useEffect(() => subscribeProjectStateChanged(projectId, load), [load, projectId]);
  useEffect(() => {
    if (!projectStatePresentation(currentState).active) return undefined;
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [currentState?.stateAuthority?.activeOperation?.id, currentState?.stateAuthority?.activeOperation?.status, load]);

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
    try { await followUpTroubleshooting(projectId, selected.session.id, message, questionType || undefined); setMessage(""); setQuestionType(null); setSelected(await getTroubleshootingSession(projectId, selected.session.id)); }
    catch (caught) { setError(caught.message); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!loaded || automaticAnalysisStarted.current || query.get("analyze") !== "1" || !query.get("operation") || selected || !operationId) return;
    automaticAnalysisStarted.current = true;
    void analyze();
  }, [loaded, operationId, query, selected, selectedServiceId]);

  if (!loaded) return <LoadingState message="Loading troubleshooting evidence…" />;
  const result = selected?.results?.[0];
  const selectedHistoryOperation = eligibleOperations.find((item) => item.id === operationId);
  const operation = selected?.operation || (selectedHistoryOperation ? { id: selectedHistoryOperation.id, action: selectedHistoryOperation.deploymentAction, commitSha: selectedHistoryOperation.commitSha, generationId: selectedHistoryOperation.generationId, failedStage: selectedHistoryOperation.failedStageLabel || selectedHistoryOperation.stageLabel, failedAt: selectedHistoryOperation.failedAt, completedAt: selectedHistoryOperation.completedAt, startedAt: selectedHistoryOperation.startedAt, createdAt: selectedHistoryOperation.createdAt, summary: selectedHistoryOperation.errorMessage, failureOwner: selectedHistoryOperation.failureOwner, externalProvider: selectedHistoryOperation.externalProvider, failureCode: selectedHistoryOperation.failureCode, failureServiceName: selectedHistoryOperation.failureServiceName, diagnosis: selectedHistoryOperation.diagnosis } : null);
  const groups = selected?.evidence?.groups || {};
  const questions = selected?.suggestedQuestions || [];

  const runtimeServices = Array.isArray(currentState?.infrastructureEvidence?.runtimeIdentity?.services) ? currentState.infrastructureEvidence.runtimeIdentity.services : [];
  const runtimeCandidate = selectedHistoryOperation?.aiRuntimeAnalysisCandidate === true;
  const details = result?.diagnosticDetails || {};
  if (!eligibleOperations.length && !selected && !error) return <div className="workspace-page troubleshooting-page troubleshooting-empty-page dg-trouble">
    <PageHeader description="Review a failed deployment when diagnostic evidence is available." title="Troubleshooting" />
    <EmptyState action={<Link className="secondary-button" to={`/projects/${projectId}/pipeline`}>View deployment history</Link>} icon="check" message="There are no failed deployments with saved diagnostic evidence." title="No troubleshooting evidence yet" />
  </div>;

  return <div className="workspace-page troubleshooting-page dg-trouble">
    <PageHeader description="Review the diagnosis first, then inspect supporting evidence only when needed." title="Troubleshooting" />
    {error ? <ErrorState message={error} onRetry={() => void load(selected?.session?.id)} /> : null}

    <div className="dg-ts-layout">
    <div className="dg-ts-main">
    {operation ? <section className="dg-ts-issue"><div className="compact-section-heading"><div><h2>{label(operation.action)} failed</h2></div><StatusChip status="failed">Failed</StatusChip></div><div className="troubleshooting-operation-grid"><article><span>Affected service</span><strong>{operation.diagnosis?.serviceName || operation.failureServiceName || "Project deployment"}</strong></article>{operation.failedStageLabel || operation.failedStage ? <article><span>Stage</span><strong>{operation.failedStageLabel || label(operation.failedStage)}</strong></article> : null}{operationTimestamp(operation) ? <article><span>When</span><strong>{date(operationTimestamp(operation))}</strong></article> : null}{operation.commitSha ? <article><span>Commit</span><strong>{String(operation.commitSha).slice(0, 12)}</strong></article> : null}</div><p className="troubleshooting-failure-summary">{operation.diagnosis?.summary || operation.summary || result?.summary || "The selected deployment has saved evidence for diagnosis."}</p>{operation.diagnosis?.recommendedAction ? <p className="state warning"><strong>Recommended action:</strong> {operation.diagnosis.recommendedAction}</p> : null}<details className="troubleshooting-advanced"><summary>Technical details</summary><div className="troubleshooting-operation-grid"><article><span>Failure owner</span><strong>{label(operation.diagnosis?.failureOwner || operation.failureOwner || selected?.evidence?.context?.failureOwner || "UNVERIFIED")}</strong></article>{operation.diagnosis?.terminalFailureCode || operation.failureCode ? <article><span>Failure code</span><strong>{operation.diagnosis?.terminalFailureCode || operation.failureCode}</strong></article> : null}{operation.diagnosis?.rootCauseCode ? <article><span>Root cause</span><strong>{operation.diagnosis.rootCauseCode}</strong></article> : null}{operation.generationId ? <article><span>Generation</span><strong>{generation(operation.generationId)}</strong></article> : null}</div></details></section> : null}

    {result ? <section className="troubleshooting-diagnosis"><div className="compact-section-heading"><div><h2>Diagnosis</h2><p>{result.summary}</p></div></div><section><h3>What happened</h3><p>{result.technicalDetails}</p></section><section><h3>Recommended action</h3><p>{details.recommendedAction || result.rootCause}</p><ol className="remediation-list">{result.remediationSteps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}</ol></section><section><h3>Recovery</h3><p><strong>{label(details.retryRecommendation?.decision || "INSUFFICIENT_EVIDENCE")}</strong> — {details.retryRecommendation?.reason || "No evidence-based retry recommendation is available."}</p></section><section><h3>Suggested questions</h3><div className="quick-actions">{questions.map((question) => <button className="subtle-button" key={question.type} onClick={() => { setMessage(question.label); setQuestionType(question.type); }} type="button">{question.label}</button>)}</div></section><details className="troubleshooting-advanced"><summary>Analysis details</summary><p><strong>Likely responsibility:</strong> {label(details.likelyResponsibility || "INSUFFICIENT_EVIDENCE")}</p><p><strong>Root cause:</strong> {result.rootCause}</p><p>Confidence {Math.round(Number(result.confidence) * 100)}% · {result.limitations}</p></details></section> : null}

    {selected ? <Card><div><p className="eyebrow">Evidence viewer</p><h2>Sanitized operation evidence</h2><p>Raw evidence is grouped and collapsed by default. Every item belongs to operation {selected.session.pipelineRunId.slice(0, 8)}.</p></div><div className="troubleshooting-evidence-groups">{Object.entries(groups).map(([source, items]) => <details key={source}><summary>{sourceLabels[source] || label(source)} <span>{items.length} item{items.length === 1 ? "" : "s"}</span></summary><ol>{items.map((item, index) => <li key={item.eventId || index}><div><strong>{label(item.stage)}</strong><time>{date(item.timestamp)}</time></div><pre>{item.text}</pre></li>)}</ol></details>)}</div></Card> : null}

    {selected ? <Card className="troubleshooting-chat"><div><p className="eyebrow">Follow-up assistant</p><h2>Ask about this operation</h2><p>The most recent bounded conversation and the same sanitized evidence snapshot are used for every answer.</p></div><div className="troubleshooting-chat-history">{selected.messages?.length ? selected.messages.map((item) => <article data-role={item.role} key={item.id}><strong>{item.role === "user" ? "You" : "DeployGuard"}</strong><p>{item.content}</p></article>) : <p className="muted">Ask a follow-up after reviewing the diagnosis.</p>}</div><form className="troubleshooting-followup" onSubmit={send}><label className="field"><span>Follow-up question</span><textarea autoComplete="off" maxLength="1000" name="followUpQuestion" onChange={(event) => { setMessage(event.target.value); setQuestionType(null); }} value={message} /></label><button className="secondary-button" disabled={busy || message.trim().length < 2}>{busy ? "Working…" : "Send follow-up"}</button></form></Card> : null}
    </div>
    <aside className="dg-ts-side">
    <Card className="troubleshooting-command">
      <div><h2>Choose a deployment</h2><p>Start an analysis for a failed deployment with saved evidence.</p></div>
      <label className="field"><span>Troubleshooting candidate</span><select name="troubleshootingOperation" onChange={(event) => { setOperationId(event.target.value); setSelected(null); }} value={operationId}><option value="">Select a failed attempt</option>{eligibleOperations.map((item) => <option key={item.id} value={item.id}>Attempt {item.attempt} · {label(item.deploymentAction)} · {item.failedStageLabel || item.stageLabel}</option>)}</select></label>
      {runtimeCandidate && runtimeServices.length > 1 ? <label className="field"><span>LIVE runtime service</span><select aria-label="Troubleshooting runtime service" onChange={(event) => setSelectedServiceId(event.target.value)} value={selectedServiceId}>{runtimeServices.map((service) => <option key={service.serviceId} value={service.serviceId}>{service.serviceName}</option>)}</select></label> : null}
      <div className="quick-actions"><button className="button" disabled={busy || !operationId} onClick={analyze} type="button">{busy ? "Analyzing evidence…" : "Analyze deployment"}</button>{selected ? <button className="secondary-button" disabled={busy} onClick={regenerate} type="button">Retry analysis</button> : null}</div>
      {!eligibleOperations.length ? <p className="muted">No operation has bounded persisted failure evidence or generation-correlated LIVE runtime evidence.</p> : null}
    </Card>
    {sessions.length ? <Card><p className="eyebrow">Analysis history</p><div className="session-list">{sessions.map((session) => <button className="subtle-button" key={session.id} onClick={async () => { setOperationId(session.pipelineRunId); setSelected(await getTroubleshootingSession(projectId, session.id)); }}>{session.id.slice(0, 8)} · {label(session.providerMode)} · {date(session.updatedAt)}</button>)}</div></Card> : null}
    </aside>
    </div>
  </div>;
}
