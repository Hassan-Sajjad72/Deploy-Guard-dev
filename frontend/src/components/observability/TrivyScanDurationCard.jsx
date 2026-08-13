export default function TrivyScanDurationCard({ scan }) {
  return (
    <section className="panel">
      <h2>Trivy Scan</h2>
      <dl className="details-list">
        <dt>Status</dt>
        <dd>{scan?.scanStatus || "-"}</dd>
        <dt>Duration</dt>
        <dd>{scan?.durationMs ? `${(scan.durationMs / 1000).toFixed(1)} s` : "-"}</dd>
        <dt>Total</dt>
        <dd>{scan?.totalVulnerabilities ?? "-"}</dd>
        <dt>Critical / High</dt>
        <dd>{scan ? `${scan.criticalCount} / ${scan.highCount}` : "-"}</dd>
        <dt>Medium / Low</dt>
        <dd>{scan ? `${scan.mediumCount} / ${scan.lowCount}` : "-"}</dd>
        <dt>Decision</dt>
        <dd>{scan?.policyDecision || "-"}</dd>
      </dl>
    </section>
  );
}
