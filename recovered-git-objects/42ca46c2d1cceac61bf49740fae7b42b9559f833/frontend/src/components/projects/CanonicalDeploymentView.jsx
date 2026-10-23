import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import ErrorState from "../common/ErrorState.jsx";
import { StatusBadge } from "../common/Premium.jsx";
import { useToast } from "../../hooks/useToast.js";
import { executeNormalReleaseAction } from "../../utils/normalReleaseAction.js";
import { commandErrorForCanonicalFetch } from "../../utils/canonicalCommandError.js";
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

export default function CanonicalDeploymentView({ canonicalFetchVersion, currentState, onRefresh, projectId }) {
  const { notify } = useToast();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [actionFailure, setActionFailure] = useState(null);
  const actionError = commandErrorForCanonicalFetch(actionFailure, canonicalFetchVersion);
  const action = deploymentActionPresentation(currentState, projectId);
  const phases = deploymentPhasePresentation(currentState);
  const cost = deploymentCostPresentation(currentState.estimatedCost);
  const progress = Math.max(0, Math.min(100, Number(currentState.progress?.percentage || 0)));

  useEffect(() => {
    setActionFailure((failure) => failure?.canonicalFetchVersion === canonicalFetchVersion ? failure : null);
  }, [canonicalFetchVersion]);

  async function execute() {
    if (inFlight.current || action?.kind !== "command") return;
    inFlight.current = true;
    setBusy(true);
    setActionFailure(null);
    try {
      const message = await executeNormalReleaseAction(projectId, currentState);
      await onRefresh();
      if (message) notify(message, "success");
    } catch (caught) {
      setActionFailure({ message: caught.message, canonicalFetchVersion });
    } finally {
      inFlight.current = false;
      setBusy(false);
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
          <StatusBadge status={currentState.developerState} />
          <strong className="simple-progress-number">{progress}%</strong>
        </div>
      </div>
      <div className="deployment-progress-track" aria-label={`Deployment progress ${progress}%`}><span style={{ width: `${progress}%` }} /></div>
      <ol className="overview-stage-rail" aria-label="Deployment phases">
        {phases.map((phase) => <li className={`stage-${phase.status} ${phase.status === "running" ? "is-current" : ""}`} data-phase={phase.key} data-status={phase.status} key={phase.key}>
          <span aria-hidden="true" />
          <small>{phase.label}</small>
        </li>)}
      </ol>
      {actionError ? <ErrorState message={actionError} /> : null}
      <div className="canonical-deployment-footer">
        <div className="simple-primary-actions">
          {action?.kind === "command" ? <button className="button" disabled={busy} onClick={execute} type="button">{busy ? "Working…" : action.label}</button> : null}
          {action?.kind === "link" ? <Link className="button" to={action.href}>{action.label}</Link> : null}
          {action?.kind === "external" ? <a className="button" href={action.href} rel="noreferrer" target="_blank">{action.label}</a> : null}
        </div>
        <Link className="subtle-button" to={`/projects/${projectId}/logs`}>View application logs</Link>
      </div>
    </section>

    {currentState.applicationError ? <section className="panel-flat canonical-application-error">
      <p className="eyebrow">Application action required</p>
      <h2>Check your application</h2>
      <p>{currentState.applicationError.message}</p>
    </section> : null}

    <div className="canonical-release-grid">
      <section className="panel-flat canonical-release-card">
        <p className="eyebrow">Latest attempt</p>
        <h2>{currentState.latestAttempt ? `Release ${currentState.latestAttempt.releaseRevision || "—"}` : "No deployment yet"}</h2>
        <dl>
          <div><dt>Status</dt><dd>{currentState.latestAttempt?.status?.replaceAll("_", " ") || "Not started"}</dd></div>
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
  </div>;
}
