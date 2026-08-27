import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import ErrorState from "../common/ErrorState.jsx";
import { StatusBadge } from "../common/Premium.jsx";
import { StageRail } from "../common/DesignSystem.jsx";
import { useToast } from "../../hooks/useToast.js";
import { commandErrorForCanonicalFetch } from "../../utils/canonicalCommandError.js";
import { deployGithubActionsDeployment, destroyGithubActionsDeployment, getGithubActionsDeploymentHistory, getProjectDetailedCurrentState, retryGithubActionsDeployment } from "../../api/projectApi.js";
import { useAuth } from "../../hooks/useAuth.js";
import {
  deploymentActionPresentation,
  deploymentCostPresentation,
  deploymentPhasePresentation,
} from "../../utils/developerDeploymentPresentation.js";

function date(value) {
  return value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
    : "—";
}

function shortCommit(value) {
  return value ? String(value).slice(0, 12) : "—";
}

export default function CanonicalDeploymentView({ canManage = false, canonicalFetchVersion, currentState, onRefresh, projectId }) {
  const { notify } = useToast();
  const { role } = useAuth();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [actionFailure, setActionFailure] = useState(null);
  const [githubDeployment, setGithubDeployment] = useState(null);
  const [githubHistory, setGithubHistory] = useState([]);
  const [retryBusy, setRetryBusy] = useState(false);
  const [destroyDialog, setDestroyDialog] = useState(null);
  const [destroyPhrase, setDestroyPhrase] = useState("");
  const [destroyBusy, setDestroyBusy] = useState(false);
  const [redeployBusy, setRedeployBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState(null);
  const lastReconciledOperation = useRef(null);
  const dismissedDestroyOperation = useRef(null);
  const actionError = commandErrorForCanonicalFetch(actionFailure, canonicalFetchVersion);
  const action = deploymentActionPresentation(currentState, projectId);
  const phases = deploymentPhasePresentation(currentState);
  const cost = deploymentCostPresentation(currentState.estimatedCost);
  const progress = Math.max(0, Math.min(100, Number(currentState.progress?.percentage || 0)));

  useEffect(() => {
    setActionFailure((failure) => failure?.canonicalFetchVersion === canonicalFetchVersion ? failure : null);
  }, [canonicalFetchVersion]);

  useEffect(() => {
    let cancelled = false;
    async function sync() {
      try {
        const response = await getGithubActionsDeploymentHistory(projectId);
        if (!cancelled) {
          const latest = response.operations?.[0] || null;
          const signature = latest ? `${latest.id}:${latest.status}:${latest.stage}:${latest.conclusion || ""}` : null;
          setGithubHistory(response.operations || []);
          setGithubDeployment(latest);
          if (signature && lastReconciledOperation.current && signature !== lastReconciledOperation.current) void onRefresh();
          lastReconciledOperation.current = signature;
        }
      } catch { /* canonical error UI remains authoritative */ }
    }
    void sync();
    const timer = window.setInterval(sync, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [projectId]);

  const latestDestroy = githubDeployment?.deploymentAction === "destroy" ? githubDeployment : null;
  const destroyInProgress = Boolean(
    currentState.developerState === "destroying"
    || (latestDestroy && ["queued", "running"].includes(latestDestroy.status))
  );

  useEffect(() => {
    if (!latestDestroy) return;
    if (["queued", "running"].includes(latestDestroy.status)) {
      setDestroyDialog("running");
      return;
    }
    if (latestDestroy.status === "completed" && dismissedDestroyOperation.current !== latestDestroy.id) {
      setDestroyDialog("completed");
      return;
    }
    if (latestDestroy.status === "failed") setDestroyDialog("failed");
  }, [latestDestroy?.id, latestDestroy?.status]);

  async function loadDiagnostics() {
    if (role !== "admin" || diagnostics) return;
    try { setDiagnostics((await getProjectDetailedCurrentState(projectId)).deploymentContract || null); } catch { setDiagnostics(null); }
  }

  async function execute() {
    if (inFlight.current || action?.kind !== "command") return;
    inFlight.current = true;
    setBusy(true);
    setActionFailure(null);
    try {
      const response = await deployGithubActionsDeployment(projectId);
      const deployment = response.deployment;
      setGithubDeployment(deployment?.operation || null);
      await onRefresh();
      if (deployment.message) notify(deployment.message, "success");
    } catch (caught) {
      setActionFailure({ message: caught.message, canonicalFetchVersion });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function retry() {
    if (retryBusy || githubDeployment?.status !== "failed") return;
    setRetryBusy(true);
    setActionFailure(null);
    try {
      const response = await retryGithubActionsDeployment(projectId);
      setGithubDeployment(response.deployment?.operation || null);
      await onRefresh();
      if (response.deployment?.operation?.deploymentAction === "destroy") setDestroyDialog("running");
      notify(response.deployment?.message || "Retry dispatched.", "success");
    } catch (caught) {
      setActionFailure({ message: caught.message, canonicalFetchVersion });
    } finally {
      setRetryBusy(false);
    }
  }

  async function destroy() {
    if (destroyBusy || destroyPhrase !== "DESTROY") return;
    setDestroyBusy(true);
    setActionFailure(null);
    try {
      const response = await destroyGithubActionsDeployment(projectId, destroyPhrase);
      setGithubDeployment(response.deployment?.operation || null);
      await onRefresh();
      setDestroyDialog("running");
      setDestroyPhrase("");
      notify(response.deployment?.message || "Destroy dispatched.", "success");
    } catch (caught) {
      setActionFailure({ message: caught.message, canonicalFetchVersion });
    } finally {
      setDestroyBusy(false);
    }
  }

  async function redeploy() {
    if (redeployBusy || currentState.developerState !== "live") return;
    setRedeployBusy(true);
    setActionFailure(null);
    try {
      const response = await deployGithubActionsDeployment(projectId);
      const deployment = response.deployment;
      setGithubDeployment(deployment?.operation || null);
      await onRefresh();
      if (deployment.message) notify(deployment.message, "success");
    } catch (caught) {
      setActionFailure({ message: caught.message, canonicalFetchVersion });
    } finally {
      setRedeployBusy(false);
    }
  }

  return <div className="canonical-deployment-view" data-canonical-deployment-view="true" data-developer-state={currentState.developerState}>
    <section className={`simple-deployment-card panel-flat ${["failed_application", "platform_attention"].includes(currentState.developerState) ? "needs-attention" : ""}`}>
      <div className="simple-deployment-heading">
        <div>
          <p className="eyebrow">Current deployment</p>
          <h2>{currentState.progress?.label || "Ready"}</h2>
          <p>{currentState.developerMessage}</p>
        </div>
        <div className="canonical-deployment-status">
          <div className="canonical-status-line"><StatusBadge status={currentState.developerState} /></div>
          <div className="canonical-progress-line"><span>Progress</span><strong className="simple-progress-number">{progress}%</strong></div>
        </div>
      </div>
      <div className="deployment-progress-track" aria-label={`Deployment progress ${progress}%`}><span style={{ width: `${progress}%` }} /></div>
      {currentState.advisories?.length ? <section className="state warning"><strong>Deployment guidance</strong><p>{currentState.advisories.join(" ")}</p></section> : null}
      {githubDeployment ? <div className="state" data-github-deployment-status={githubDeployment.status}>
        <strong>GitHub Actions deployment: {String(githubDeployment.status || "queued").replaceAll("_", " ")}</strong>
        {githubDeployment.deployedUrl ? <p>Live URL: <a href={githubDeployment.deployedUrl} rel="noreferrer" target="_blank">{githubDeployment.deployedUrl}</a></p> : <p>{githubDeployment.stageLabel || "Waiting for workflow"}</p>}
        {githubDeployment.workflowUrl ? <a href={githubDeployment.workflowUrl} rel="noreferrer" target="_blank">View GitHub Actions run</a> : null}
          {githubDeployment.status === "failed" ? <>
          <p><strong>Failed stage:</strong> {githubDeployment.failedStageLabel || githubDeployment.stageLabel}</p>
          {githubDeployment.failureOwner === "platform" ? <p>No AWS credential or project setting is required from you. DeployGuard must correct its platform authorization.</p> : null}
          {githubDeployment.errorMessage ? <p>{githubDeployment.errorMessage}</p> : null}
          {canManage ? <button className="secondary-button" disabled={retryBusy} onClick={retry} type="button">{retryBusy ? "Retrying…" : githubDeployment.deploymentAction === "destroy" ? "Retry destroy" : "Retry deployment"}</button> : null}
          <Link className="subtle-button" to={`/projects/${projectId}/pipeline`}>View Pipeline Logs</Link>
        </> : null}
      </div> : null}
      <StageRail phases={phases} />
      {actionError ? <ErrorState message={actionError} /> : null}
      <div className="canonical-deployment-footer">
        <div aria-label="Deployment actions" className="simple-primary-actions" role="group">
          {canManage && action?.kind === "command" ? <button className="button" disabled={busy} onClick={execute} type="button">{busy ? "Working…" : action.label}</button> : null}
          {canManage && action?.kind === "link" ? <Link className="button" to={action.href}>{action.label}</Link> : null}
          {action?.kind === "external" ? <a className="button" href={action.href} rel="noreferrer" target="_blank">{action.label}</a> : null}
          {canManage && currentState.developerState === "live" ? <button className="secondary-button" disabled={busy || redeployBusy || destroyBusy || destroyInProgress} onClick={redeploy} type="button">{redeployBusy ? "Redeploying…" : "Redeploy"}</button> : null}
          {canManage && githubDeployment?.deployedUrl && !destroyInProgress ? <button className="danger-text-button" disabled={busy || redeployBusy || destroyBusy} onClick={() => setDestroyDialog("confirm")} type="button">Destroy infrastructure</button> : null}
        </div>
        <Link className="subtle-button" to={`/projects/${projectId}/pipeline`}>View pipeline logs</Link>
      </div>
    </section>

    {githubHistory.length ? <section className="panel-flat">
      <p className="eyebrow">GitHub Actions history</p>
      <h2>Deployment attempts</h2>
      <div className="active-run-list">{githubHistory.map((operation) => <article className="active-run-item" key={operation.id}>
        <span className="active-run-identity"><strong>Attempt {operation.attempt}: {operation.status}</strong><small>{shortCommit(operation.commitSha)} · {date(operation.createdAt)}{operation.retryOfOperationId ? " · retry" : ""}</small></span>
        {operation.workflowUrl ? <a className="text-link" href={operation.workflowUrl} rel="noreferrer" target="_blank">Workflow</a> : null}
      </article>)}</div>
    </section> : null}

    {destroyDialog === "confirm" ? <div className="destroy-modal-backdrop"><section aria-modal="true" className="destroy-modal" role="dialog">
      <p className="eyebrow">Permanent project deletion</p><h2>Delete this project and its owned resources?</h2>
      <p>DeployGuard will clean every recorded generation by exact identity, delete project-owned persistence, images, secrets and routing, then remove this project's records. Shared platform networking, cluster and load balancer remain untouched. Type <strong>DESTROY</strong> to confirm.</p>
      <label className="field"><span>Confirmation</span><input autoComplete="off" autoFocus onChange={(event) => setDestroyPhrase(event.target.value)} value={destroyPhrase} /></label>
      <div className="destroy-modal-actions"><button className="subtle-button" disabled={destroyBusy} onClick={() => { setDestroyDialog(null); setDestroyPhrase(""); }} type="button">Cancel</button><button className="danger-button" disabled={destroyBusy || destroyPhrase !== "DESTROY"} onClick={destroy} type="button">{destroyBusy ? "Destroying…" : "Confirm destroy"}</button></div>
    </section></div> : null}

    {destroyDialog === "running" ? <div className="destroy-modal-backdrop" data-destroy-popup="running"><section aria-modal="true" className="destroy-modal" role="dialog">
      <p className="eyebrow">Infrastructure lifecycle</p><h2>Destroy running</h2>
      <p>DeployGuard is cleaning each recorded generation and the separate project-owned resources. Shared platform infrastructure is not part of this operation.</p>
      {latestDestroy ? <p data-destroy-operation={latestDestroy.id}>Operation {latestDestroy.id} · {latestDestroy.status || "queued"} · phase {latestDestroy.phase || latestDestroy.stage || "queued"} · requested {date(latestDestroy.requestedAt || latestDestroy.createdAt)}</p> : null}
      <div className="destroy-modal-actions"><Link className="secondary-button" to={`/projects/${projectId}/pipeline`}>View Progress</Link></div>
    </section></div> : null}

    {destroyDialog === "failed" ? <div className="destroy-modal-backdrop" data-destroy-popup="failed"><section aria-modal="true" className="destroy-modal" role="dialog">
      <p className="eyebrow">Infrastructure lifecycle</p><h2>Destroy failed</h2>
      <p>{latestDestroy?.errorMessage || "GitHub Actions could not complete the infrastructure removal."}</p>
      <div className="destroy-modal-actions"><Link className="secondary-button" to={`/projects/${projectId}/pipeline`}>View Progress</Link>{canManage ? <button className="danger-button" disabled={retryBusy} onClick={retry} type="button">{retryBusy ? "Retrying…" : "Retry destroy"}</button> : null}</div>
    </section></div> : null}

    {destroyDialog === "completed" ? <div className="destroy-modal-backdrop" data-destroy-popup="completed"><section aria-modal="true" className="destroy-modal" role="dialog">
      <p className="eyebrow">Infrastructure lifecycle</p><h2>Destroy completed</h2>
      <p>Project deletion is confirmed. Exact project and generation resources were cleaned, and the project record was removed.</p>
      <div className="destroy-modal-actions"><Link className="secondary-button" to={`/projects/${projectId}/pipeline`}>View Progress</Link><button className="button" onClick={() => { dismissedDestroyOperation.current = latestDestroy?.id || null; setDestroyDialog(null); }} type="button">Close</button></div>
    </section></div> : null}

    {currentState.applicationError ? <section className="panel-flat canonical-application-error">
      <p className="eyebrow">Application action required</p>
      <h2>Check your application</h2>
      <p>{currentState.applicationError.message}</p>
    </section> : null}

    <div className="canonical-release-grid">
      <section className="panel-flat canonical-release-card">
        <p className="eyebrow">Latest attempt</p>
        <h2>{currentState.latestAttempt ? `Attempt ${currentState.latestAttempt.attempt || "—"}` : "No deployment yet"}</h2>
        <dl>
          <div><dt>Status</dt><dd>{currentState.latestAttempt?.status?.replaceAll("_", " ") || "Not started"}</dd></div>
          <div><dt>Generation</dt><dd>{shortCommit(currentState.latestAttempt?.generationId)}</dd></div>
          <div><dt>Commit</dt><dd>{shortCommit(currentState.latestAttempt?.commit || currentState.commit)}</dd></div>
          <div><dt>Updated</dt><dd>{date(currentState.latestAttempt?.occurredAt)}</dd></div>
        </dl>
      </section>
      <section className="panel-flat canonical-release-card canonical-stable-card">
        <p className="eyebrow">Stable release</p>
        <h2>{currentState.stableRelease ? `Release ${currentState.stableRelease.revision}` : "No verified stable release"}</h2>
        <dl>
          <div><dt>Commit</dt><dd>{shortCommit(currentState.stableRelease?.commit)}</dd></div>
          <div><dt>Promoted</dt><dd>{date(currentState.stableRelease?.promotedAt)}</dd></div>
          <div><dt>Live URL</dt><dd>{currentState.stableUrl || "Available after verification"}</dd></div>
        </dl>
      </section>
      <section className="panel-flat canonical-release-card">
        <p className="eyebrow">Estimated cost</p>
        <h2>{cost.label}</h2>
        <p>{cost.detail}</p>
        {currentState.missingConfiguration?.length ? <p className="canonical-configuration-note">{currentState.missingConfiguration.length} required configuration value{currentState.missingConfiguration.length === 1 ? "" : "s"} remaining.</p> : null}
      </section>
    </div>
    {role === "admin" ? <details className="panel-flat"><summary onClick={() => void loadDiagnostics()}>Developer details</summary>{diagnostics ? <dl><div><dt>Commit</dt><dd>{shortCommit(diagnostics.commitSha)}</dd></div><div><dt>Application root</dt><dd>{diagnostics.appRoot}</dd></div><div><dt>Runtime</dt><dd>{[diagnostics.language, diagnostics.framework, diagnostics.packageManager].filter(Boolean).join(" · ")}</dd></div><div><dt>Docker strategy</dt><dd>{diagnostics.dockerStrategy} {diagnostics.dockerTemplate || ""}</dd></div><div><dt>Evidence warnings</dt><dd>{diagnostics.warnings?.join(" ") || "None"}</dd></div><div><dt>Structural blockers</dt><dd>{diagnostics.blockers?.join(" ") || "None"}</dd></div></dl> : <p>Open to load sanitized deployment-contract evidence.</p>}</details> : null}
  </div>;
}
