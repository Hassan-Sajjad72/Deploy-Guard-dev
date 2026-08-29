import { StatusBadge } from "../common/Premium.jsx";

function human(value) {
  return String(value || "not started").replaceAll("_", " ");
}

function terminalLabel(operation) {
  if (operation?.terminalResult === "live") return "Live";
  if (operation?.terminalResult === "failed") return "Failed";
  return human(operation?.latestAttempt?.status);
}

function duration(value) {
  if (!Number.isFinite(value) || value < 0) return "Not available";
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

/** Canonical, refresh-safe deployment operation view from current-state only. */
export default function NormalReleaseOperationPanel({
  releaseLane,
  busy,
  canStart,
  startLabel,
  onStart,
}) {
  const operation = releaseLane?.intent?.operation;
  if (!operation) return null;
  const latest = operation.latestAttempt;
  const signals = operation.observability;
  return <section className={`deployment-canvas normal-release-operation panel-flat ${operation.terminalResult === "failed" ? "deployment-canvas-failed" : ""}`} aria-label="Deployment operation" data-release-operation={latest.status}>
    <div className="deployment-canvas-header">
      <div>
        <p className="eyebrow">Latest attempted release</p>
        <div className="deployment-stage-title"><span className={operation.terminalResult === "failed" ? "active-stage-beacon beacon-danger" : "active-stage-beacon"} /><h2>Release {latest.releaseRevision}</h2></div>
        <p>Commit {latest.sourceCommitShortSha} · durable deployment operation</p>
      </div>
      <div className="normal-release-terminal-result"><span>Result</span><StatusBadge status={operation.terminalResult === "live" ? "passed" : operation.terminalResult || latest.status}>{terminalLabel(operation)}</StatusBadge></div>
    </div>
    <ol className="overview-stage-rail normal-release-stage-rail" aria-label="Normal release phases">
      {operation.phases.map((phase) => <li className={`stage-${phase.status} ${phase.status === "running" ? "is-current" : ""}`} data-phase={phase.key} data-status={phase.status} key={phase.key}>
        <span />
        <small>{phase.label}</small>
        <strong>{human(phase.status)}</strong>
      </li>)}
    </ol>
    {operation.evidence ? <div className="normal-release-evidence" aria-label="Release gate evidence">
      <span data-gate="release" data-status={operation.evidence.security.state}>Release evidence <strong>{human(operation.evidence.security.state)}</strong></span>
    </div> : null}
    {signals ? <section className="normal-release-observability" aria-label="Normal release observability">
      <div className="normal-release-observability-header">
        <div><p className="eyebrow">Operation signals</p><strong>Durable release activity</strong></div>
        <span data-operation-health={signals.serviceHealth.state}>Service health <strong>{human(signals.serviceHealth.state)}</strong></span>
      </div>
      <div className="normal-release-metrics" aria-label="Release metrics">
        <span><strong>{signals.metrics.completedPhases}/{signals.metrics.totalPhases}</strong> phases passed</span>
        <span><strong>{signals.metrics.succeededEffects}/{signals.metrics.totalEffects}</strong> effects succeeded</span>
        <span><strong>{duration(signals.metrics.durationMs)}</strong> operation time</span>
      </div>
      <div className="normal-release-signal-columns">
        <div><small>Timeline</small><ol>{signals.events.map((event) => <li data-operation-event={event.phase} data-status={event.state} key={`${event.phase}-${event.occurredAt}`}><span>{human(event.phase)}</span><strong>{human(event.state)}</strong></li>)}</ol></div>
        <div><small>Activity log</small><ol>{signals.logs.map((entry) => <li data-operation-log={entry.safeCode} data-level={entry.level} key={`${entry.safeCode}-${entry.occurredAt}`}><span>{entry.label}</span><strong>{human(entry.level)}</strong></li>)}</ol></div>
      </div>
    </section> : null}
    <div className="normal-release-operation-footer">
      <span>State is restored from the authoritative project current-state response.</span>
      {canStart ? <button className="button" data-overview-action="start_pipeline" disabled={busy} onClick={onStart} type="button">{busy ? "Working…" : startLabel || "Deploy"}</button> : null}
    </div>
  </section>;
}
