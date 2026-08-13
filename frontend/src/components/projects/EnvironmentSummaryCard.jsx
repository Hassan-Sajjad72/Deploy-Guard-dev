export default function EnvironmentSummaryCard({ summary }) {
  if (!summary) {
    return null;
  }

  return (
    <section className="panel">
      <h2>Environment Variables</h2>
      <dl className="details-list">
        <dt>Count</dt>
        <dd>{summary.count}</dd>
        <dt>Keys</dt>
        <dd>{summary.keys?.join(", ") || "-"}</dd>
        <dt>Required</dt>
        <dd>{summary.required?.join(", ") || "None detected"}</dd>
        <dt>Missing</dt>
        <dd>{summary.missing?.join(", ") || "None"}</dd>
        <dt>Detection evidence</dt>
        <dd>{summary.detected?.length ? summary.detected.map((item) => `${item.key} (${item.phase}${item.required ? ", required" : ", optional"})`).join(", ") : "None detected"}</dd>
        <dt>Values Included</dt>
        <dd>{summary.valuesIncluded ? "yes" : "no"}</dd>
        <dt>Contains Secret Values</dt>
        <dd>{summary.containsSecretValues ? "yes" : "no"}</dd>
      </dl>
    </section>
  );
}
