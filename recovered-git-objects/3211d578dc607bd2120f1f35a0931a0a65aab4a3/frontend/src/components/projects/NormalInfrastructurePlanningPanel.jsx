import { StatusBadge } from "../common/Premium.jsx";

function money(cost) {
  if (cost?.state === "deferred") return "Deferred";
  if (cost?.state !== "real" || !Number.isFinite(cost.monthlyCost)) return "Unavailable";
  return `${cost.currency || "USD"} ${cost.monthlyCost.toFixed(2)} / month`;
}

/** Sanitized first-release plan/apply state from the canonical current-state response. */
export default function NormalInfrastructurePlanningPanel({
  releaseLane,
  busy,
  canAct,
  actionLabel,
  onAction,
}) {
  const planning = releaseLane?.intent?.infrastructurePlanning;
  if (!releaseLane?.intent?.firstRelease || !planning) return null;
  const summary = planning.review?.resourceSummary;
  return <section className="deployment-canvas normal-infrastructure-operation panel-flat" aria-label="First release infrastructure operation">
    <div className="deployment-canvas-header">
      <div><p className="eyebrow">First deployment foundation</p><h2>Infrastructure preparation</h2><p>Durable normal-v1 planning and approval state</p></div>
      <StatusBadge status={planning.applyState === "applied" ? "passed" : planning.applyState}>{String(planning.applyState).replaceAll("_", " ")}</StatusBadge>
    </div>
    <div className="normal-release-evidence" aria-label="Infrastructure planning evidence">
      <span data-infrastructure-state="plan">Terraform plan <strong>{String(planning.planState).replaceAll("_", " ")}</strong></span>
      <span data-infrastructure-state="apply">Infrastructure apply <strong>{String(planning.applyState).replaceAll("_", " ")}</strong></span>
      <span data-infrastructure-state="cost">Estimated cost <strong>{money(planning.review?.costEstimate)}</strong></span>
    </div>
    {summary ? <dl className="normal-release-metrics" aria-label="Terraform resource summary">
      <span><strong>{summary.create}</strong> create</span>
      <span><strong>{summary.update}</strong> update</span>
      <span><strong>{summary.replace}</strong> replace</span>
      <span><strong>{summary.delete}</strong> delete</span>
    </dl> : null}
    <div className="normal-release-operation-footer">
      <span>Refresh restores this exact plan and approval state without publishing work.</span>
      {canAct ? <button className="button" data-overview-action="normal_infrastructure" disabled={busy} onClick={onAction} type="button">{busy ? "Working…" : actionLabel}</button> : null}
    </div>
  </section>;
}
