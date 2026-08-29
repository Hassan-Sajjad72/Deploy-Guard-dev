function money(value, currency = "USD") {
  return new Intl.NumberFormat(undefined, {
    currency,
    style: "currency",
  }).format(Number(value || 0));
}

function value(value) {
  return value === null || value === undefined || value === "" ? "-" : value;
}

export default function CostSummaryCard({ estimate }) {
  if (!estimate) {
    return (
      <section className="panel">
        <h2>Cost Summary</h2>
        <p className="muted">No estimate has been generated yet.</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="page-header">
        <div>
          <h2>{money(estimate.totalMonthlyCost, estimate.currency)} / month</h2>
          <p className="muted">{estimate.source} estimate</p>
        </div>
        <span className={`status-pill status-${estimate.status}`}>
          {estimate.status?.replaceAll("_", " ")}
        </span>
      </div>
      <dl className="details-list">
        <dt>Previous</dt>
        <dd>{money(estimate.previousMonthlyCost, estimate.currency)}</dd>
        <dt>Difference</dt>
        <dd>{money(estimate.monthlyCostDifference, estimate.currency)}</dd>
        <dt>Tier</dt>
        <dd>{value(estimate.subscriptionTier)}</dd>
        <dt>Tier Limit</dt>
        <dd>{money(estimate.tierLimitMonthlyCost, estimate.currency)}</dd>
        <dt>Warning Threshold</dt>
        <dd>{money(estimate.warningThresholdMonthlyCost, estimate.currency)}</dd>
        <dt>Pipeline Run</dt>
        <dd>{value(estimate.pipelineRunId)}</dd>
      </dl>
    </section>
  );
}
