import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { followUpTroubleshooting, getTroubleshootingSession, getTroubleshootingSessions, regenerateTroubleshooting, startTroubleshooting } from "../api/platformApi.js";
import { deployGithubActionsDeployment, getGithubActionsDeploymentHistory, getProject, getProjectCurrentState, retryGithubActionsDeployment } from "../api/projectApi.js";
import AppIcon from "../components/common/AppIcon.jsx";
import { Badge, Button, Callout, Disclosure, EmptyState, PageHeader, Status } from "../components/common/DesignSystem.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import Time from "../components/common/Time.jsx";
import { useToast } from "../hooks/useToast.js";
import { redirectDeletedProject, subscribeProjectStateChanged } from "../utils/projectStateSync.js";
import { liveWithFailedLatest, projectStatePresentation } from "../utils/projectStatePresentation.js";
import { failureTroubleshootingProjection } from "../utils/developerDeploymentPresentation.js";
import { failureRecoveryCommand } from "../utils/overviewLifecyclePresentation.js";
import { confidenceLabel, failureOwnerLabel, operationTypeLabel, retryGuidance } from "../utils/failurePresentation.js";
import { productText } from "../utils/productTerms.js";
import { formatDateTime } from "../utils/time.js";

const sourceLabels = { github_actions: "GitHub Actions", github_actions_status: "GitHub Actions", github_actions_stage: "GitHub Actions stages", railpack_build: "Build output", deployguard_build_identity: "Service and build identity", deployguard_diagnosis: "DeployGuard diagnosis", security_scan: "Security scan (Trivy)", terraform: "Infrastructure (Terraform)", aws_runtime_verification: "AWS runtime checks", cloudwatch_runtime: "Application logs", ecs_cloudwatch_runtime: "Container events", deployguard_lifecycle: "DeployGuard lifecycle" };
const RESPONSIBILITY = { REPOSITORY_APPLICATION: "Your repository", DEPLOYGUARD_PLATFORM: "DeployGuard platform", EXTERNAL_PROVIDER: "External provider", INSUFFICIENT_EVIDENCE: "Not enough evidence" };
function label(value) { return String(value || "—").replaceAll("_", " ").toLowerCase().replace(/^\w/, (letter) => letter.toUpperCase()); }
function operationTimestamp(operation) { return operation?.failedAt || operation?.completedAt || operation?.startedAt || operation?.createdAt || null; }
function aiResultModeLabel(resultMode) { return resultMode === "live" ? "Live AI" : "Evidence Only"; }
/** Renders `inline code` from AI text as code; everything else stays plain text. */
function RichText({ children }) {
  const parts = String(children || "").split(/`([^`]+)`/g);
  return parts.map((part, index) => index % 2 ? <code className="inline-code" key={index}>{part}</code> : part);
}

export default function ProjectTroubleshooting() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { notify } = useToast();
  const [query] = useSearchParams();
  const [sessions, setSessions] = useState([]);
  const [eligibleOperations, setEligibleOperations] = useState([]);
  const [operationId, setOperationId] = useState("");
  const [selected, setSelected] = useState(null);
  const [provider, setProvider] = useState(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [currentState, setCurrentState] = useState(null);
  const [canManage, setCanManage] = useState(false);
  const [selectedServiceId, setSelectedServiceId] = useState("");
  const [questionType, setQuestionType] = useState(null);
  const automaticAnalysisStarted = useRef(false);

  const load = useCallback(async (preferredSession) => {
    setError("");
    try {
      const [list, history, state, projectResponse] = await Promise.all([getTroubleshootingSessions(projectId), getGithubActionsDeploymentHistory(projectId), getProjectCurrentState(projectId), getProject(projectId)]);
      const projection = failureTroubleshootingProjection(history.operations || [], list.items || []);
      const candidates = projection.candidates;
      const failureSessions = projection.sessions;
      const requestedOperation = query.get("operation");
      const requestedSession = [preferredSession, query.get("session")]
        .map((sessionId) => failureSessions.find((session) => session.id === sessionId))
        .find(Boolean);
      // A failure is selected by default only while it is the current state (or the latest attempt behind a still-live release).
      const latestIsFailure = projectStatePresentation(state).state === "FAILED" || liveWithFailedLatest(state);
      const selectedOperationId = requestedOperation && candidates.some((item) => item.id === requestedOperation)
        ? requestedOperation
        : requestedSession?.pipelineRunId || (latestIsFailure ? candidates[0]?.id || "" : "");
      const runtimeServices = Array.isArray(state.infrastructureEvidence?.runtimeIdentity?.services) ? state.infrastructureEvidence.runtimeIdentity.services : [];
      setSessions(failureSessions); setProvider(list.provider || null); setEligibleOperations(candidates); setCurrentState(state); setCanManage(Boolean(projectResponse.project?.canManage));
      setOperationId(selectedOperationId);
      setSelectedServiceId((current) => runtimeServices.some((service) => service.serviceId === current) ? current : runtimeServices[0]?.serviceId || "");
      const existingForOperation = selectedOperationId ? failureSessions.find((session) => session.pipelineRunId === selectedOperationId)?.id : null;
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
  async function recover(command) {
    if (recovering) return;
    setRecovering(true); setError("");
    try {
      const response = command === "retry" ? await retryGithubActionsDeployment(projectId) : await deployGithubActionsDeployment(projectId);
      notify(response.deployment?.message || (command === "retry" ? "Retry started." : "Deployment started."), "success");
      navigate(`/projects/${projectId}/pipeline`);
    } catch (caught) { setError(caught.message); }
    finally { setRecovering(false); }
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
  const diagnosis = operation?.diagnosis || null;
  const failureOwner = operation?.diagnosis?.failureOwner || operation?.failureOwner;
  const retry = retryGuidance(diagnosis?.retryDecision);
  const isLatestAttempt = eligibleOperations[0]?.id === operation?.id && (projectStatePresentation(currentState).state === "FAILED" || liveWithFailedLatest(currentState));
  const recoveryCommand = canManage && isLatestAttempt ? failureRecoveryCommand({ ...selectedHistoryOperation, diagnosis, operationType: operation?.action }, currentState?.canRetry) : null;
  const safeLog = selectedHistoryOperation?.safeLog;

  if (!eligibleOperations.length && !selected && !error) return <div className="page troubleshoot-page">
    <PageHeader description="Why a deployment failed, whose problem it is, and how to fix it." title="Troubleshoot" />
    <EmptyState action={<><Button to={`/projects/${projectId}/monitoring`}>Open monitoring</Button><Button to={`/projects/${projectId}/pipeline`} tone="ghost">Deployment history</Button></>} icon="check-circle" message="No failed deployments to investigate. If your running app misbehaves, its logs and metrics are in Monitoring." title="Nothing to troubleshoot" />
  </div>;

  return <div className="page troubleshoot-page">
    <PageHeader
      actions={eligibleOperations.length > 1 || !operation ? <label className="field troubleshoot-picker"><span className="sr-only">Failed attempt</span><select name="troubleshootingOperation" onChange={(event) => { setOperationId(event.target.value); setSelected(null); }} value={operationId}><option value="">Select a failed attempt</option>{eligibleOperations.map((item) => <option key={item.id} value={item.id}>Attempt {item.attempt} · {operationTypeLabel(item)} · {productText(item.failedStageLabel || item.stageLabel)}</option>)}</select></label> : null}
      description="Why a deployment failed, whose problem it is, and how to fix it."
      title="Troubleshoot"
    />
    {error ? <ErrorState message={error} onRetry={() => void load(selected?.session?.id)} title="The request did not complete" /> : null}

    {!operation ? <EmptyState compact icon="search" message="Your project is currently healthy. Choose an earlier failed attempt above to review what went wrong." title="Choose a failed attempt" /> : <>
      <section aria-labelledby="ts-what" className="panel ts-issue">
        <div className="ts-issue-head">
          <Status tone="danger">{operationTypeLabel(operation)} failed{operation.failedStage ? ` · ${productText(operation.failedStageLabel || operation.failedStage)}` : ""}</Status>
          <span className="muted ts-when"><Time value={operationTimestamp(operation)} /></span>
        </div>
        <h2 className="ts-summary" id="ts-what">{productText(operation.diagnosis?.summary || operation.summary || result?.summary) || "DeployGuard recorded evidence for this failure but no summary."}</h2>
        {failureOwnerLabel(failureOwner, operation.diagnosis?.externalProvider || operation.externalProvider) ? <p className="ts-owner"><AppIcon name="info" size={16} />{failureOwnerLabel(failureOwner, operation.diagnosis?.externalProvider || operation.externalProvider)}</p> : null}
        <dl className="facts ts-facts">
          <div><dt>Service</dt><dd>{operation.diagnosis?.serviceName || operation.failureServiceName || selected?.evidence?.context?.runtimeServiceId || "Whole project"}</dd></div>
          <div><dt>Commit</dt><dd className="mono">{operation.commitSha ? String(operation.commitSha).slice(0, 7) : "—"}</dd></div>
          <div><dt>Diagnosis</dt><dd>{confidenceLabel(diagnosis?.confidence)}</dd></div>
        </dl>
      </section>

      <section aria-labelledby="ts-fix" className="section">
        <div className="section-head"><h2 id="ts-fix">How to fix it</h2></div>
        <div className="panel panel-pad ts-fix">
          {operation.diagnosis?.recommendedAction ? <p className="ts-action">{productText(operation.diagnosis.recommendedAction)}</p> : <p className="ts-action">Review the recorded evidence below before retrying.</p>}
          {diagnosis?.remediationSteps?.length ? <ol className="ts-steps">{diagnosis.remediationSteps.map((step, index) => <li key={`${index}-${step}`}><RichText>{productText(step)}</RichText></li>)}</ol> : null}
          <Callout title={retry.short} tone={retry.tone === "success" ? "success" : retry.tone === "warning" ? "warning" : "neutral"}><p>{retry.text}</p></Callout>
          {recoveryCommand ? <div className="actions"><Button aria-busy={recovering || undefined} disabled={recovering} icon={recoveryCommand === "retry" ? "refresh" : "deploy"} onClick={() => void recover(recoveryCommand)} tone="primary">{recoveryCommand === "retry" ? `Retry ${operationTypeLabel(operation).toLowerCase()}` : "Deploy fixed commit"}</Button>{recoveryCommand === "deploy_fixed" ? <span className="muted ts-hint">Deploys the latest commit on the branch.</span> : null}</div> : null}
        </div>
      </section>

      <Disclosure summary="Technical failure details">
        <dl className="facts-list">
          <div><dt>Failure code</dt><dd className="mono">{operation.diagnosis?.terminalFailureCode || operation.failureCode || selected?.evidence?.context?.failureCode || "Not recorded"}</dd></div>
          <div><dt>Root cause</dt><dd className="mono">{diagnosis?.rootCauseCode || "Not recorded"}</dd></div>
          <div><dt>Affected component</dt><dd>{diagnosis?.affectedComponent || "—"}</dd></div>
          <div><dt>Owner</dt><dd className="mono">{operation.diagnosis?.failureOwner || operation.failureOwner || selected?.evidence?.context?.failureOwner || "UNVERIFIED"}</dd></div>
          <div><dt>Generation</dt><dd className="mono">{operation.generationId || "Not created — the attempt stopped before runtime"}</dd></div>
          <div><dt>Observed</dt><dd>{formatDateTime(operationTimestamp(operation))}</dd></div>
          {diagnosis?.completedStages?.length ? <div><dt>Completed before failing</dt><dd>{diagnosis.completedStages.map((stage) => productText(stage.label)).join(", ")}</dd></div> : null}
        </dl>
        {diagnosis?.technicalReason ? <p className="secondary">{productText(diagnosis.technicalReason)}</p> : null}
        {safeLog ? <pre className="code">{safeLog}</pre> : null}
      </Disclosure>

      <section aria-labelledby="ts-ai" className="section">
        <div className="section-head"><h2 id="ts-ai">AI troubleshooting</h2>{selected ? <div className="actions"><Badge tone={result?.resultMode === "live" ? "neutral" : "warning"}>{aiResultModeLabel(result?.resultMode)}</Badge><Button disabled={busy} onClick={regenerate} size="sm" tone="ghost">Run again</Button></div> : null}</div>
        {!selected ? <div className="panel panel-pad ts-ai-start">
          <p>Have the AI assistant read this failure's recorded evidence and explain it in plain terms. The diagnosis above stays the authority.</p>
          {runtimeCandidate && runtimeServices.length > 1 ? <label className="field"><span>Service to analyze</span><select aria-label="Troubleshooting runtime service" onChange={(event) => setSelectedServiceId(event.target.value)} value={selectedServiceId}>{runtimeServices.map((service) => <option key={service.serviceId} value={service.serviceId}>{service.serviceName}</option>)}</select></label> : null}
          <div className="actions"><Button aria-busy={busy || undefined} disabled={busy || !operationId} icon="message" onClick={analyze} tone={recoveryCommand ? "secondary" : "primary"}>{busy ? "Analyzing…" : provider?.available ? "Analyze with AI" : "Summarize the evidence"}</Button>{!provider?.available ? <span className="muted ts-hint">{provider?.message || "AI is not connected; the summary uses recorded evidence only."}</span> : null}</div>
        </div> : null}

        {result ? <article className="panel panel-pad troubleshooting-diagnosis">
          <h3 className="ts-ai-summary"><RichText>{result.summary}</RichText></h3>
          {result.resultMode !== "live" && selected?.session?.lastError ? <p className="muted">Evidence Only reason: {selected.session.lastError}</p> : null}
          <div className="ts-ai-grid">
            <section><h4>What happened</h4><p><RichText>{result.technicalDetails}</RichText></p></section>
            <section><h4>Root cause</h4><p><RichText>{result.rootCause}</RichText></p>{details.affectedComponent ? <p className="muted">Affected: {details.affectedComponent}</p> : null}</section>
            <section><h4>Recommended fix</h4>{details.recommendedAction ? <p><RichText>{details.recommendedAction}</RichText></p> : null}<ol className="ts-steps">{result.remediationSteps.map((step, index) => <li key={`${index}-${step}`}><RichText>{step}</RichText></li>)}</ol></section>
          </div>
          <p className="muted ts-ai-foot">Likely responsibility: {RESPONSIBILITY[details.likelyResponsibility] || "Not enough evidence"} · Confidence {Math.round(Number(result.confidence) * 100)}% · {result.limitations} AI explanation only. DeployGuard's persisted deterministic diagnosis above remains authoritative.</p>
        </article> : null}

        {selected ? <div className="panel troubleshooting-chat">
          <div className="ts-chat-log" aria-live="polite">{selected.messages?.length ? selected.messages.map((item) => <article data-role={item.role} key={item.id}><strong>{item.role === "user" ? "You" : "DeployGuard"}</strong><p><RichText>{item.content}</RichText></p></article>) : <p className="muted">Ask a follow-up question about this failure.</p>}</div>
          {questions.length ? <div className="actions ts-suggestions">{questions.map((question) => <button className="btn btn-sm" key={question.type} onClick={() => { setMessage(question.label); setQuestionType(question.type); }} type="button">{question.label}</button>)}</div> : null}
          <form className="ts-followup" onSubmit={send}><label className="field"><span className="sr-only">Follow-up question</span><textarea autoComplete="off" maxLength="1000" name="followUpQuestion" onChange={(event) => { setMessage(event.target.value); setQuestionType(null); }} placeholder="Ask about this failure…" rows="2" value={message} /></label><Button aria-busy={busy || undefined} disabled={busy || message.trim().length < 2} type="submit">{busy ? "Sending…" : "Ask"}</Button></form>
        </div> : null}

        {selected ? <Disclosure meta={`${Object.values(groups).reduce((total, items) => total + items.length, 0)} items`} summary="Evidence the AI used">
          <div className="ts-evidence">{Object.entries(groups).map(([source, items]) => <details key={source}><summary>{sourceLabels[source] || label(source)}<span className="muted"> · {items.length}</span></summary><ol>{items.map((item, index) => <li key={item.eventId || index}><p className="muted">{label(item.stage)} · <Time value={item.timestamp} /></p><pre className="code">{item.text}</pre></li>)}</ol></details>)}</div>
        </Disclosure> : null}

        {sessions.length > 1 ? <details className="troubleshooting-sessions disclosure"><summary>Earlier analyses ({sessions.length})</summary><div className="disclosure-body actions">{sessions.map((session) => <button className="btn btn-sm" key={session.id} onClick={async () => { setOperationId(session.pipelineRunId); setSelected(await getTroubleshootingSession(projectId, session.id)); }} type="button">{label(session.providerMode)} · {formatDateTime(session.updatedAt)}</button>)}</div></details> : null}
      </section>
    </>}
  </div>;
}
