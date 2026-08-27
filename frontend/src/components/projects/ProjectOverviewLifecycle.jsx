import { useEffect, useRef, useState } from "react";
import {
  Button,
  Card,
  MetricCard,
  Modal,
  StageRail,
  StatusChip,
} from "../common/DesignSystem.jsx";
import ErrorState from "../common/ErrorState.jsx";
import { useToast } from "../../hooks/useToast.js";
import {
  deployGithubActionsDeployment,
  destroyGithubActionsDeployment,
  getGithubActionsRollbackCandidates,
  rollbackGithubActionsDeployment,
  retryGithubActionsDeployment,
} from "../../api/projectApi.js";
import { deploymentPhasePresentation } from "../../utils/developerDeploymentPresentation.js";
import { canonicalOverviewState, overviewLifecycleActions, overviewLifecycleCopy } from "../../utils/overviewLifecyclePresentation.js";

function formatDate(value) {
  return value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
    : "Unavailable";
}

function shortCommit(value) {
  return value ? String(value).slice(0, 12) : "Unavailable";
}

function summaryTone(status) {
  if (["LIVE", "READY", "DESTROYED"].includes(status)) return "success";
  if (status === "FAILED") return "danger";
  if (["DEPLOYING", "DESTROYING"].includes(status)) return "info";
  return "warning";
}

/**
 * Overview intentionally receives one canonical current-state snapshot only.
 * It never queries operation history or reconstructs actions from a URL,
 * workflow status, or a separate client-side lifecycle value.
 */
export default function ProjectOverviewLifecycle({ canManage = false, currentState, onRefresh, projectId }) {
  const { notify } = useToast();
  const dispatching = useRef(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [destroyOpen, setDestroyOpen] = useState(false);
  const [destroyPhrase, setDestroyPhrase] = useState("");
  const [acceptedOperation, setAcceptedOperation] = useState(null);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [rollbackCandidates, setRollbackCandidates] = useState([]);
  const [rollbackLoading, setRollbackLoading] = useState(false);
  const [rollbackError, setRollbackError] = useState("");
  const state = canonicalOverviewState(currentState);
  const authority = currentState.stateAuthority || {};
  const copy = overviewLifecycleCopy(currentState);
  const latestOperationFailed = authority.latestCompletedOperation?.outcome === "failed";
  // The rail follows the same canonical authority as the card/actions. This
  // prevents an older failed attempt from rendering over a newer LIVE state.
  const phases = deploymentPhasePresentation({
    ...currentState,
    developerState: state === "FAILED" || latestOperationFailed ? "failed_application" : state.toLowerCase(),
  });
  const latest = currentState.latestAttempt;
  const health = authority.applicationHealth || {};
  const reconciliation = authority.reconciliation || {};
  const generationState = currentState.generationState || { generations: [] };

  useEffect(() => {
    if (!acceptedOperation) return;
    if (String(authority.activeOperation?.id || "") !== String(acceptedOperation.id || "")) {
      setAcceptedOperation(null);
    }
  }, [acceptedOperation, authority.activeOperation?.id]);

  async function runDeploy() {
    if (dispatching.current || !canManage) return;
    dispatching.current = true;
    setBusy("deploy");
    setAcceptedOperation(null);
    setError("");
    try {
      const response = await deployGithubActionsDeployment(projectId);
      setAcceptedOperation(response.deployment?.operation || null);
      await onRefresh();
      notify(response.deployment?.message || (state === "LIVE" ? "Redeployment submitted." : "Deployment submitted."), "success");
    } catch (caught) {
      setError(caught.message);
    } finally {
      dispatching.current = false;
      setBusy("");
    }
  }

  async function retry() {
    if (dispatching.current || !canManage || !currentState.canRetry) return;
    dispatching.current = true;
    setBusy("retry");
    setError("");
    try {
      const response = await retryGithubActionsDeployment(projectId);
      await onRefresh();
      notify(response.deployment?.message || "Retry submitted.", "success");
    } catch (caught) {
      setError(caught.message);
    } finally {
      dispatching.current = false;
      setBusy("");
    }
  }

  async function destroy() {
    if (dispatching.current || !canManage || destroyPhrase !== "DESTROY") return;
    dispatching.current = true;
    setBusy("destroy");
    setError("");
    try {
      const response = await destroyGithubActionsDeployment(projectId, destroyPhrase);
      setAcceptedOperation(response.deployment?.operation || null);
      setDestroyOpen(false);
      setDestroyPhrase("");
      await onRefresh();
      notify(response.deployment?.message || "Infrastructure destruction submitted.", "success");
    } catch (caught) {
      setError(caught.message);
    } finally {
      dispatching.current = false;
      setBusy("");
    }
  }

  async function openRollback() {
    if (dispatching.current || !canManage || busy) return;
    setRollbackOpen(true);
    setRollbackLoading(true);
    setRollbackError("");
    setRollbackCandidates([]);
    try {
      const response = await getGithubActionsRollbackCandidates(projectId);
      setRollbackCandidates(Array.isArray(response.candidates) ? response.candidates : []);
    } catch (caught) {
      setRollbackError(caught.message);
    } finally {
      setRollbackLoading(false);
    }
  }

  async function rollback() {
    const target = rollbackCandidates[0];
    if (dispatching.current || !canManage || !target) return;
    dispatching.current = true;
    setBusy("rollback");
    setAcceptedOperation(null);
    setRollbackError("");
    try {
      const response = await rollbackGithubActionsDeployment(projectId, target.operationId);
      setAcceptedOperation(response.deployment?.operation || null);
      setRollbackOpen(false);
      await onRefresh();
      notify(response.deployment?.message || "Rollback submitted.", "success");
    } catch (caught) {
      setRollbackError(caught.message);
    } finally {
      dispatching.current = false;
      setBusy("");
    }
  }

  function actions() {
    return overviewLifecycleActions(currentState, canManage).map((action) => {
      if (action.kind === "link") return <Button key={action.label} to={`/projects/${projectId}/pipeline`} tone="secondary">{action.label}</Button>;
      if (action.kind === "external") return <Button className="overview-action overview-action-open" href={action.href} key={action.label} rel="noreferrer" target="_blank">{action.label}</Button>;
      if (action.kind === "disabled") return <Button className="overview-action overview-action-disabled" disabled key={action.label} title={action.reason}>{action.label}</Button>;
      if (action.command === "destroy") return <Button className="overview-action overview-action-destroy" disabled={Boolean(busy)} key={action.label} onClick={() => setDestroyOpen(true)} tone="danger">{action.label}</Button>;
      if (action.command === "retry") return <Button disabled={Boolean(busy)} key={action.label} onClick={() => void retry()}>{busy === "retry" ? "Retrying…" : action.label}</Button>;
      if (action.command === "rollback") return <Button className="overview-action overview-action-rollback" disabled={Boolean(busy)} key={action.label} onClick={() => void openRollback()} tone="secondary">{action.label}</Button>;
      const redeploying = action.command === "redeploy" && busy === "deploy";
      const actionClass = action.command === "redeploy"
        ? `overview-action overview-action-redeploy${redeploying ? " overview-action-in-progress" : ""}`
        : "";
      return <Button aria-busy={redeploying || undefined} className={actionClass} disabled={Boolean(busy)} key={action.label} onClick={() => void runDeploy()}>{busy === "deploy" ? (action.command === "redeploy" ? "Redeploying…" : "Deploying…") : action.label}</Button>;
    });
  }

  return <div className="project-overview-lifecycle" data-canonical-overview="true" data-canonical-state={state}>
    <Card className={`overview-lifecycle-card overview-state-${state.toLowerCase()}`}>
      <div className="overview-lifecycle-heading">
        <div><p className="eyebrow">Current lifecycle</p><h2>{copy.title}</h2><p>{copy.message}</p></div>
        <StatusChip status={state} tone={summaryTone(state)}>{state.replaceAll("_", " ")}</StatusChip>
      </div>
      <div aria-label={`Deployment progress ${currentState.progress?.percentage || 0}%`} className="deployment-progress-track"><span style={{ width: `${Math.max(0, Math.min(100, Number(currentState.progress?.percentage || 0)))}%` }} /></div>
      <StageRail phases={phases} />
      {error ? <ErrorState message={error} /> : null}
      {acceptedOperation ? <p className="state success" data-accepted-operation={acceptedOperation.id}>Operation {acceptedOperation.id} is {acceptedOperation.status || "queued"}. Phase: {acceptedOperation.phase || acceptedOperation.stage || "queued"}. Requested {formatDate(acceptedOperation.requestedAt || acceptedOperation.createdAt)}. View Pipeline for progress.</p> : null}
      <div aria-label="Canonical lifecycle actions" className="overview-actions" role="group">{actions()}</div>
      {state === "LIVE" && !latestOperationFailed && canManage && !currentState.stableRelease?.rollbackAvailable ? <p className="muted">No previous successful release is available.</p> : null}
    </Card>

    <section aria-label="Deployment summary" className="overview-summary-grid">
      <MetricCard detail={authority.reason || currentState.developerMessage} label="Current state" tone={summaryTone(state)} value={state.replaceAll("_", " ")} />
      <MetricCard detail={`Commit ${shortCommit(latest?.commit || currentState.commit)}`} label="Latest operation" tone={latest?.status === "failed_application" ? "danger" : "neutral"} value={latest ? `Attempt ${latest.attempt || "—"}` : "No deployment yet"} />
      <MetricCard detail={`${health.source?.replaceAll("_", " ") || "No health source"} · ${formatDate(health.observedAt)}`} label="Application health" tone={health.status === "healthy" ? "success" : health.status === "failed" ? "danger" : "warning"} value={health.status || "Unavailable"} />
      <MetricCard detail="GitHub Actions duration is available when synchronized on Pipeline." label="Last deployment duration" value="Unavailable" />
    </section>

    <section className="overview-evidence-line"><span>Source: {reconciliation.source?.replaceAll("_", " ") || "unavailable"}</span><span>Last updated: {formatDate(reconciliation.lastReconciledAt)}</span><StatusChip status={reconciliation.freshness || "unavailable"}>{reconciliation.freshness || "Unavailable"}</StatusChip></section>

    {generationState.generations.length ? <Card className="overview-generation-state">
      <p className="eyebrow">Immutable generations</p>
      <h2>Release isolation</h2>
      <dl>
        <div><dt>LIVE</dt><dd>{shortCommit(generationState.liveGenerationId)}</dd></div>
        <div><dt>DEPLOYING</dt><dd>{shortCommit(generationState.candidateGenerationId)}</dd></div>
        <div><dt>Cleanup pending</dt><dd>{generationState.generations.filter((generation) => generation.status === "cleanup_pending").length}</dd></div>
      </dl>
    </Card> : null}

    {destroyOpen ? <Modal labelledBy="overview-destroy-title" onClose={() => { if (!busy) { setDestroyOpen(false); setDestroyPhrase(""); } }}>
      <p className="eyebrow">Permanent project deletion</p><h2 id="overview-destroy-title">Delete this project and its owned resources?</h2>
      <p>Each recorded generation and the separate project resources will be cleaned by exact identity. Shared platform networking, cluster and load balancer remain untouched. Type <strong>DESTROY</strong> to confirm.</p>
      <label className="field"><span>Confirmation</span><input autoComplete="off" autoFocus onChange={(event) => setDestroyPhrase(event.target.value)} value={destroyPhrase} /></label>
      <div className="overview-modal-actions"><Button disabled={Boolean(busy)} onClick={() => { setDestroyOpen(false); setDestroyPhrase(""); }} tone="ghost">Cancel</Button><Button disabled={busy === "destroy" || destroyPhrase !== "DESTROY"} onClick={() => void destroy()} tone="danger">{busy === "destroy" ? "Destroying…" : "Confirm destroy"}</Button></div>
    </Modal> : null}

    {rollbackOpen ? <Modal labelledBy="overview-rollback-title" onClose={() => { if (!busy) setRollbackOpen(false); }}>
      <p className="eyebrow">Application release</p><h2 id="overview-rollback-title">Rollback application?</h2>
      {rollbackLoading ? <p>Loading the previous immutable release…</p> : null}
      {rollbackError ? <ErrorState message={rollbackError} /> : null}
      {!rollbackLoading && !rollbackError && !rollbackCandidates.length ? <p>No previous successful release is available.</p> : null}
      {rollbackCandidates[0] ? <div className="state"><strong>Release {rollbackCandidates[0].releaseRevision}</strong><p>Commit {shortCommit(rollbackCandidates[0].commitSha)} · image {shortCommit(rollbackCandidates[0].imageDigest)} · port {rollbackCandidates[0].appPort} · health {rollbackCandidates[0].healthCheckPath}</p></div> : null}
      <p>The stored image digest, task definition, runtime configuration, port and health path will be reused. Repository code will not be rebuilt.</p>
      <div className="overview-modal-actions"><Button disabled={Boolean(busy)} onClick={() => setRollbackOpen(false)} tone="ghost">Cancel</Button><Button disabled={rollbackLoading || Boolean(rollbackError) || !rollbackCandidates.length || busy === "rollback"} onClick={() => void rollback()} tone="danger">{busy === "rollback" ? "Rolling back…" : "Confirm rollback"}</Button></div>
    </Modal> : null}
  </div>;
}
