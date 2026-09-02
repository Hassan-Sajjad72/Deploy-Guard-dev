import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { followUpTroubleshooting, getTroubleshootingSession, getTroubleshootingSessions, regenerateTroubleshooting, startTroubleshooting } from "../api/platformApi.js";
import { getGithubActionsDeploymentHistory, getProjectCurrentState } from "../api/projectApi.js";
import { Card, EmptyState, PageHeader, StatusChip } from "../components/common/DesignSystem.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { subscribeProjectStateChanged } from "../utils/projectStateSync.js";
import { projectStatePresentation } from "../utils/projectStatePresentation.js";

const sourceLabels = { github_actions: "GitHub Actions", github_actions_status: "GitHub Actions", github_actions_stage: "GitHub Actions stages", railpack_build: "Railpack / build evidence", terraform: "Terraform", aws_runtime_verification: "AWS runtime verification", cloudwatch_runtime: "CloudWatch application logs", ecs_cloudwatch_runtime: "ECS / CloudWatch runtime events", deployguard_lifecycle: "DeployGuard lifecycle evidence" };
function label(value) { return String(value || "Unavailable").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function date(value) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Unavailable"; }
function generation(value) { return value ? String(value).slice(0, 12) : "Not created — deployment failed before runtime generation."; }
function operationTimestamp(operation) { return operation?.failedAt || operation?.completedAt || operation?.startedAt || operation?.createdAt || null; }

export default function ProjectTroubleshooting() {
  const { projectId } = useParams();
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
      const liveGenerationId = state.infrastructureEvidence?.runtimeIdentity?.generationId || state.stateAuthority?.runtime?.generationId || null;
      const candidates = (history.operations || []).filter((operation) => operation.aiAnalysisEligible === true || (operation.aiRuntimeAnalysisCandidate === true && operation.generationId === liveGenerationId));
      const requestedOperation = query.get("operation");
      const runtimeServices = Array.isArray(state.infrastructureEvidence?.runtimeIdentity?.services) ? state.infrastructureEvidence.runtimeIdentity.services : [];
      setSessions(list.items || []); setProvider(list.provider || null); setEligibleOperations(candidates); setCurrentState(state);
      setOperationId((current) => current || (requestedOperation && candidates.some((item) => item.id === requestedOperation) ? requestedOperation : candidates[0]?.id || ""));
      setSelectedServiceId((current) => runtimeServices.some((service) => service.serviceId === current) ? current : runtimeServices[0]?.serviceId || "");
      const existingForOperation = requestedOperation ? list.items?.find((session) => session.pipelineRunId === requestedOperation)?.id : null;
      const requested = preferredSession || query.get("session") || existingForOperation || (!requestedOperation ? list.items?.[0]?.id : null);
      if (requested) setSelected(await getTroubleshootingSession(projectId, requested));
    } catch (caught) { setError(caught.message); }
    finally { setLoaded(true); }
  }, [projectId, query]);
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
    try { const created = await startTroubleshooting(projectId, operationId, selectedServiceId || undefined); await load(created.session.id); }
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
  const operation = selected?.operation || (selectedHistoryOperation ? { id: selectedHistoryOperation.id, action: selectedHistoryOperation.deploymentAction, commitSha: selectedHistoryOperation.commitSha, generationId: selectedHistoryOperation.generationId, failedStage: selectedHistoryOperation.failedStageLabel || selectedHistoryOperation.stageLabel, failedAt: selectedHistoryOperation.failedAt, completedAt: selectedHistoryOperation.completedAt, startedAt: selectedHistoryOperation.startedAt, createdAt: selectedHistoryOperation.createdAt, summary: selectedHistoryOperation.errorMessage, failureOwner: selectedHistoryOperation.failureOwner, externalProvider: selectedHistoryOperation.externalProvider, failureCode: selectedHistoryOperation.failureCode, failureServiceName: selectedHistoryOperation.failureServiceName } : null);
  const groups = selected?.evidence?.groups || {};
  const questions = selected?.suggestedQuestions || [];
  const providerStatus = provider?.availability || provider?.mode || "unavailable";

  const runtimeServices = Array.isArray(currentState?.infrastructureEvidence?.runtimeIdentity?.services) ? currentState.infrastructureEvidence.runtimeIdentity.services : [];
  const runtimeCandidate = selectedHistoryOperation?.aiRuntimeAnalysisCandidate === true;
  const details = result?.diagnosticDetails || {};

  if (!eligibleOperations.length && !selected && !error) return <div className="workspace-page troubleshooting-page troubleshooting-empty-page">
    <PageHeader description="Analyze failed deployments or current LIVE application evidence." eyebrow="Diagnostics" title="Troubleshooting" />
    <EmptyState action={<Link className="secondary-button" to={`/projects/${projectId}/pipeline`}>View deployment history</Link>} icon="check" message="DeployGuard can analyze persisted deployment failures and generation-correlated LIVE runtime logs when evidence exists." title="No troubleshooting evidence available" />
    <p className="troubleshooting-provider-meta">AI provider: {provider?.provider ? label(provider.provider) : "Evidence-only"} · {provider?.available ? "Connected" : label(providerStatus)}</p>
  </div>;

  return <div className="workspace-page troubleshooting-page">
    <PageHeader context={selected ? `Session ${selected.session.id.slice(0, 8)} · Operation ${selected.session.pipelineRunId.slice(0, 8)}` : "Select a troubleshooting candidate"} description="Review the diagnosis first, then inspect its bounded supporting evidence." eyebrow="Diagnostics" status={details.problemType === "LIVE_RUNTIME_ISSUE" || runtimeCandidate ? "healthy" : "failed"} title="Troubleshooting" />
    {error ? <ErrorState message={error} onRetry={() => void load(selected?.session?.id)} /> : null}
    <Card className="troubleshooting-command">
      <div><p className="eyebrow">Provider status</p><h2>{provider?.provider ? `${label(provider.provider)} · ${label(providerStatus)}` : "Evidence-only analysis"}</h2><p>{provider?.message || "Provider status is unavailable. Deterministic evidence-only diagnostics remain available."}</p></div>
      <label className="field"><span>Troubleshooting candidate</span><select onChange={(event) => { setOperationId(event.target.value); setSelected(null); }} value={operationId}>{eligibleOperations.map((item) => <option key={item.id} value={item.id}>Attempt {item.attempt} · {item.aiRuntimeAnalysisCandidate ? "LIVE runtime" : label(item.deploymentAction)} · {item.failedStageLabel || item.stageLabel}</option>)}</select></label>
      {runtimeCandidate && runtimeServices.length > 1 ? <label className="field"><span>LIVE runtime service</span><select aria-label="Troubleshooting runtime service" onChange={(event) => setSelectedServiceId(event.target.value)} value={selectedServiceId}>{runtimeServices.map((service) => <option key={service.serviceId} value={service.serviceId}>{service.serviceName}</option>)}</select></label> : null}
      <div className="quick-actions"><button className="button" disabled={busy || !operationId} onClick={analyze} type="button">{busy ? "Analyzing evidence…" : provider?.available ? "Analyze with Gemini" : "Analyze available evidence"}</button>{selected ? <button className="secondary-button" disabled={busy} onClick={regenerate} type="button">Retry analysis</button> : null}</div>
      {!eligibleOperations.length ? <p className="muted">No operation has bounded persisted failure evidence or generation-correlated LIVE runtime evidence.</p> : null}
    </Card>

    {operation ? <Card><div className="compact-section-heading"><div><p className="eyebrow">Selected operation</p><h2>{details.problemType === "LIVE_RUNTIME_ISSUE" || runtimeCandidate ? "LIVE runtime issue" : `${label(operation.action)} failed`}</h2></div><StatusChip status={details.problemType === "LIVE_RUNTIME_ISSUE" || runtimeCandidate ? "healthy" : "failed"}>{details.problemType === "LIVE_RUNTIME_ISSUE" || runtimeCandidate ? "LIVE" : "Failed"}</StatusChip></div><div className="troubleshooting-operation-grid"><article><span>Project</span><strong>{selected?.evidence?.context?.project?.name || "Current project"}</strong></article><article><span>Service</span><strong>{operation.failureServiceName || selected?.evidence?.context?.runtimeServiceId || "Project operation"}</strong></article><article><span>Deterministic owner</span><strong>{label(operation.failureOwner || selected?.evidence?.context?.failureOwner || "UNVERIFIED")}{(operation.externalProvider || selected?.evidence?.context?.externalProvider) ? ` — ${label(operation.externalProvider || selected?.evidence?.context?.externalProvider)}` : ""}</strong></article><article><span>Failure code</span><strong>{operation.failureCode || selected?.evidence?.context?.failureCode || "Not applicable"}</strong></article><article><span>Action</span><strong>{label(operation.action)}</strong></article><article><span>Commit</span><strong>{String(operation.commitSha || "Unavailable").slice(0, 12)}</strong></article><article><span>Generation</span><strong>{generation(operation.generationId)}</strong></article><article><span>Observed stage</span><strong>{operation.failedStageLabel || label(operation.failedStage)}</strong></article><article><span>Timestamp</span><strong>{date(operationTimestamp(operation))}</strong></article></div><p className="troubleshooting-failure-summary">{operation.summary || result?.summary || "The selected operation has bounded evidence available for diagnosis."}</p></Card> : null}

    {result ? <Card className="troubleshooting-diagnosis"><div className="compact-section-heading"><div><p className="eyebrow">Diagnosis</p><h2>{result.summary}</h2></div><StatusChip status={result.resultMode === "live" ? "healthy" : "warning"}>{result.resultMode === "live" ? "Gemini" : "Evidence-only fallback"}</StatusChip></div><section><h3>Likely responsibility</h3><p><strong>{label(details.likelyResponsibility || "INSUFFICIENT_EVIDENCE")}</strong> — AI diagnosis only. Deterministic ownership above remains authoritative.</p></section><section><h3>What happened</h3><p>{result.technicalDetails}</p></section>{details.completedStages?.length ? <section><h3>What DeployGuard successfully completed</h3><ol className="remediation-list">{details.completedStages.map((stage, index) => <li key={`${stage.stage}-${index}`}>{label(stage.stage)}</li>)}</ol></section> : null}<section><h3>Root cause</h3><p>{result.rootCause}</p><p className="muted">Affected component: {details.affectedComponent || "Insufficient evidence"}</p></section><section><h3>Recommended fix</h3><p>{details.recommendedAction}</p><ol className="remediation-list">{result.remediationSteps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}</ol></section><section><h3>Retry recommendation</h3><p><strong>{label(details.retryRecommendation?.decision || "INSUFFICIENT_EVIDENCE")}</strong> — {details.retryRecommendation?.reason || "No evidence-based retry recommendation is available."}</p></section><p className="muted">Confidence {Math.round(Number(result.confidence) * 100)}% · {result.limitations}</p><section><h3>Suggested questions</h3><div className="quick-actions">{questions.map((question) => <button className="subtle-button" key={question.type} onClick={() => { setMessage(question.label); setQuestionType(question.type); }} type="button">{question.label}</button>)}</div></section>{result.evidenceReferences?.length ? <div><h3>Evidence references</h3><div className="evidence-reference-list">{result.evidenceReferences.map((reference, index) => <Link className="subtle-button" key={`${reference.eventId || reference.source}-${index}`} to={`/projects/${projectId}/pipeline`}>{sourceLabels[reference.source] || label(reference.source)} · {label(reference.stage)}</Link>)}</div></div> : null}</Card> : null}

    {selected ? <Card><div><p className="eyebrow">Evidence viewer</p><h2>Sanitized operation evidence</h2><p>Raw evidence is grouped and collapsed by default. Every item belongs to operation {selected.session.pipelineRunId.slice(0, 8)}.</p></div><div className="troubleshooting-evidence-groups">{Object.entries(groups).map(([source, items]) => <details key={source}><summary>{sourceLabels[source] || label(source)} <span>{items.length} item{items.length === 1 ? "" : "s"}</span></summary><ol>{items.map((item, index) => <li key={item.eventId || index}><div><strong>{label(item.stage)}</strong><time>{date(item.timestamp)}</time></div><pre>{item.text}</pre></li>)}</ol></details>)}</div></Card> : null}

    {selected ? <Card className="troubleshooting-chat"><div><p className="eyebrow">Follow-up assistant</p><h2>Ask about this operation</h2><p>The most recent bounded conversation and the same sanitized evidence snapshot are used for every answer.</p></div><div className="troubleshooting-chat-history">{selected.messages?.length ? selected.messages.map((item) => <article data-role={item.role} key={item.id}><strong>{item.role === "user" ? "You" : "DeployGuard"}</strong><p>{item.content}</p></article>) : <p className="muted">Ask a follow-up after reviewing the diagnosis.</p>}</div><form className="troubleshooting-followup" onSubmit={send}><label className="field"><span>Follow-up question</span><textarea maxLength="1000" onChange={(event) => { setMessage(event.target.value); setQuestionType(null); }} value={message} /></label><button className="secondary-button" disabled={busy || message.trim().length < 2}>{busy ? "Working…" : "Send follow-up"}</button></form></Card> : null}
    {sessions.length ? <Card><p className="eyebrow">Analysis history</p><div className="session-list">{sessions.map((session) => <button className="subtle-button" key={session.id} onClick={async () => setSelected(await getTroubleshootingSession(projectId, session.id))}>{session.id.slice(0, 8)} · {label(session.providerMode)} · {date(session.updatedAt)}</button>)}</div></Card> : null}
  </div>;
}
