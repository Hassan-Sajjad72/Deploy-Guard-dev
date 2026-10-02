import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ActionMenu,
  Button,
  Callout,
  Modal,
  PageHeader,
  Status,
} from "../common/DesignSystem.jsx";
import AppIcon from "../common/AppIcon.jsx";
import ErrorState from "../common/ErrorState.jsx";
import Time from "../common/Time.jsx";
import { useToast } from "../../hooks/useToast.js";
import {
  deployGithubActionsDeployment,
  getGithubActionsRollbackCandidates,
  rollbackGithubActionsDeployment,
  retryGithubActionsDeployment,
} from "../../api/projectApi.js";
import { deploymentPhasePresentation } from "../../utils/developerDeploymentPresentation.js";
import { canonicalOverviewState, overviewFailureOwnershipLabel, overviewLifecycleActions, overviewLifecycleCopy } from "../../utils/overviewLifecyclePresentation.js";
import { projectStateLabel, projectStateTone } from "../../utils/projectStatePresentation.js";
import { formatDateTime } from "../../utils/time.js";
import { productText } from "../../utils/productTerms.js";

function shortCommit(value) {
  return value ? String(value).slice(0, 7) : null;
}

function PhaseRail({ phases }) {
  return <ol aria-label="Deployment progress" className="phase-rail">
    {phases.map((phase) => <li className={`is-${phase.status}`} data-phase={phase.key} data-status={phase.status} key={phase.key}>
      <span aria-hidden="true" className="phase-mark">{phase.status === "passed" ? <AppIcon name="check" size={12} /> : phase.status === "failed" ? <AppIcon name="close" size={12} /> : null}</span>
      <span className="phase-label">{phase.label}</span>
      <span className="sr-only">{phase.status === "passed" ? "done" : phase.status === "running" ? "in progress" : phase.status === "failed" ? "failed" : "not started"}</span>
    </li>)}
  </ol>;
}

/**
 * Overview intentionally receives one canonical current-state snapshot only.
 * It never queries operation history or reconstructs actions from a URL,
 * workflow status, or a separate client-side lifecycle value.
 */
export default function ProjectOverviewLifecycle({ canManage = false, currentState, onRefresh, project, projectId }) {
  const { notify } = useToast();
  const dispatching = useRef(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [acceptedOperation, setAcceptedOperation] = useState(null);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [rollbackCandidates, setRollbackCandidates] = useState([]);
  const [rollbackLoading, setRollbackLoading] = useState(false);
  const [rollbackError, setRollbackError] = useState("");
  const state = canonicalOverviewState(currentState);
  const authority = currentState.stateAuthority || {};
  const copy = overviewLifecycleCopy(currentState);
  const latestOperationFailed = authority.latestCompletedOperation?.outcome === "failed" && !authority.activeOperation;
  const runtimeLive = state === "LIVE";
  // The rail follows the same canonical authority as the card/actions. This
  // prevents an older failed attempt from rendering over a newer LIVE state.
  const phases = deploymentPhasePresentation({
    ...currentState,
    developerState: state === "FAILED" || latestOperationFailed ? "failed_application" : state.toLowerCase(),
  });
  const latest = currentState.latestAttempt;
  const diagnosis = latest?.diagnosis || null;
  const failureOwnershipLabel = overviewFailureOwnershipLabel(currentState);
  const release = currentState.stableRelease;
  const repository = currentState.repository || project?.repositoryFullName;
  const branch = currentState.branch || project?.targetBranch;
  const troubleshootPath = `/projects/${projectId}/troubleshooting${latest?.operationId ? `?operation=${encodeURIComponent(latest.operationId)}` : ""}`;

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
      notify(response.deployment?.message || (state === "LIVE" ? "Redeployment started." : "Deployment started."), "success");
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
      notify(response.deployment?.message || "Retry started.", "success");
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
      const response = await rollbackGithubActionsDeployment(projectId, target.targetOperationId);
      setAcceptedOperation(response.deployment?.operation || null);
      setRollbackOpen(false);
      await onRefresh();
      notify(response.deployment?.message || "Rollback started.", "success");
    } catch (caught) {
      setRollbackError(caught.message);
    } finally {
      dispatching.current = false;
      setBusy("");
    }
  }

  // Lifecycle actions come from the canonical presenter; Overview decides only where each one sits.
  const lifecycleActions = overviewLifecycleActions(currentState, canManage);
  const primary = [];
  const menu = [];
  for (const action of lifecycleActions) {
    if (action.kind === "external") continue;
    if (action.kind === "link") { primary.push(<Button key={action.label} to={`/projects/${projectId}/pipeline`}>{action.label}</Button>); continue; }
    if (action.command === "destroy") { menu.push({ icon: "trash", label: "Destroy infrastructure…", to: `/projects/${projectId}/settings?section=danger`, danger: true }); continue; }
    if (action.kind === "disabled" || action.command === "rollback") {
      menu.push({ icon: "rollback", label: "Roll back to previous release…", disabled: action.kind === "disabled" || Boolean(busy), title: action.reason, onSelect: () => void openRollback() });
      continue;
    }
    if (action.command === "retry") { primary.push(<Button aria-busy={busy === "retry" || undefined} disabled={Boolean(busy)} key={action.label} onClick={() => void retry()} tone="primary">{busy === "retry" ? "Retrying…" : action.label}</Button>); continue; }
    const redeploying = action.command === "redeploy" && busy === "deploy";
    primary.push(<Button aria-busy={redeploying || undefined} disabled={Boolean(busy)} icon={action.command === "redeploy" ? "refresh" : "deploy"} key={action.label} onClick={() => void runDeploy()} tone="primary">{busy === "deploy" ? (action.command === "redeploy" ? "Redeploying…" : "Deploying…") : action.label}</Button>);
  }

  const statusSentence = (() => {
    if (state === "LIVE") return "The current release passed its health check and is serving traffic.";
    if (state === "DEPLOYING") return <>{currentState.progress?.label || copy.message}{authority.activeOperation?.startedAt ? <> · started <Time value={authority.activeOperation.startedAt} /></> : null}</>;
    if (state === "FAILED") return productText(diagnosis?.summary) || copy.message;
    if (state === "READY") return `Nothing has been deployed yet. Deploying builds ${branch || "the selected branch"} and starts it on AWS.`;
    if (state === "DESTROYED") return <>Infrastructure was removed{authority.latestCompletedOperation?.completedAt ? <> <Time value={authority.latestCompletedOperation.completedAt} /></> : null}. History is kept; deploy again to recreate it.</>;
    return copy.message;
  })();

  return <>
    <PageHeader
      actions={<>
        {runtimeLive && currentState.stableUrl ? <Button external href={currentState.stableUrl}>Open app</Button> : null}
        {primary}
        <ActionMenu items={menu} label="More project actions" />
      </>}
      description={<span className="overview-source">
        {repository ? <a className="overview-source-link" href={`https://github.com/${repository}`} rel="noreferrer" target="_blank" translate="no"><AppIcon name="github" size={14} />{repository}</a> : null}
        {branch ? <span translate="no"><AppIcon name="branch" size={14} />{branch}</span> : null}
      </span>}
      title={<span translate="no">{project?.name || "Project"}</span>}
    />

    <section aria-label="Current state" className={`status-panel is-${state.toLowerCase()}`} data-canonical-overview="true" data-canonical-state={state}>
      <div className="status-line">
        <Status active={state === "DEPLOYING" || state === "DESTROYING"} className="status-lg" tone={state === "FAILED" ? "danger" : projectStateTone(state)}>{state === "FAILED" ? copy.title : projectStateLabel(state)}</Status>
        <p className="status-sentence">{statusSentence}</p>
      </div>

      {runtimeLive && currentState.stableUrl ? <a className="status-url" href={currentState.stableUrl} rel="noreferrer" target="_blank"><AppIcon name="globe" size={16} /><span>{currentState.stableUrl.replace(/^https?:\/\//, "")}</span><AppIcon name="external" size={14} /></a> : null}

      {state === "DEPLOYING" || state === "DESTROYING" ? <PhaseRail phases={phases} /> : null}

      {state === "FAILED" ? <div className="actions"><Button icon="wrench" to={troubleshootPath}>See what went wrong</Button>{failureOwnershipLabel ? <span className="sr-only"> ({failureOwnershipLabel})</span> : null}</div> : null}

      {runtimeLive && latestOperationFailed ? <Callout actions={<Button size="sm" to={troubleshootPath}>See what went wrong</Button>} title={copy.title} tone="warning">
        <p>{productText(diagnosis?.summary) || "The latest deployment did not complete."} Your previous release is still serving traffic.</p>
      </Callout> : null}

      {error ? <ErrorState message={error} title="The action could not start" /> : null}
      {acceptedOperation ? <p aria-live="polite" className="status-accepted" role="status">Request accepted at {formatDateTime(acceptedOperation.requestedAt || acceptedOperation.createdAt)}. <Link className="link" to={`/projects/${projectId}/pipeline`}>Follow progress</Link></p> : null}
      {state === "LIVE" && !latestOperationFailed && canManage && !release?.rollbackAvailable ? <p className="muted status-note">No previous successful release is available to roll back to.</p> : null}
    </section>

    {rollbackOpen ? <Modal labelledBy="overview-rollback-title" onClose={() => { if (!busy) setRollbackOpen(false); }}>
      <h2 id="overview-rollback-title">Roll back to the previous release?</h2>
      {rollbackLoading ? <p>Finding the previous release…</p> : null}
      {rollbackError ? <ErrorState message={rollbackError} title="Rollback is not available" /> : null}
      {!rollbackLoading && !rollbackError && !rollbackCandidates.length ? <p>No previous successful release is available.</p> : null}
      {rollbackCandidates[0] ? <dl className="facts-list rollback-target">
        <div><dt>Release</dt><dd>{rollbackCandidates[0].releaseRevision}</dd></div>
        <div><dt>Commit</dt><dd className="mono">{shortCommit(rollbackCandidates[0].commitSha) || "Not recorded"}</dd></div>
        <div><dt>Services</dt><dd>{rollbackCandidates[0].services?.length || 0} immutable image{rollbackCandidates[0].services?.length === 1 ? "" : "s"}</dd></div>
        <div><dt>Port and health check</dt><dd><span className="mono">{rollbackCandidates[0].appPort}</span> · <span className="mono">{rollbackCandidates[0].healthCheckPath}</span></dd></div>
      </dl> : null}
      <p>The exact stored images, task definition, runtime configuration, port and health path are reused. Nothing is rebuilt from source.</p>
      <div className="dialog-actions"><Button disabled={Boolean(busy)} onClick={() => setRollbackOpen(false)} tone="ghost">Cancel</Button><Button aria-busy={busy === "rollback" || undefined} disabled={rollbackLoading || Boolean(rollbackError) || !rollbackCandidates.length || busy === "rollback"} onClick={() => void rollback()} tone="primary">{busy === "rollback" ? "Rolling back…" : "Roll back"}</Button></div>
    </Modal> : null}
  </>;
}
