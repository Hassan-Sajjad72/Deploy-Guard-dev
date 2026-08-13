import SecurityPolicyDecisionBadge from "./SecurityPolicyDecisionBadge.jsx";

function value(value) {
  return value === null || value === undefined || value === "" ? "-" : value;
}

export default function SecurityScanSummaryCard({ scan }) {
  const classification = scan.rawSummary?.classification || {};
  const policy = scan.rawSummary?.policy || {};
  return (
    <section className="panel">
      <div className="page-header">
        <div>
          <h2>Scan Summary</h2>
          <p className="muted">{scan.imageUri || scan.imageName}</p>
        </div>
        <SecurityPolicyDecisionBadge decision={scan.policyDecision} />
      </div>
      <dl className="details-list">
        <dt>Status</dt>
        <dd>{value(scan.scanStatus)}</dd>
        <dt>Scanner</dt>
        <dd>{value(scan.scannerVersion || scan.scanner)}</dd>
        <dt>Image Tag</dt>
        <dd>{value(scan.imageTag)}</dd>
        <dt>Scanner note</dt>
        <dd>{value(scan.policyReason)}</dd>
        <dt>Application dependencies</dt>
        <dd>{value(classification.appDependency)}</dd>
        <dt>Base image / OS</dt>
        <dd>{(classification.baseImage || 0) + (classification.osPackage || 0)}</dd>
        <dt>Fix available</dt>
        <dd>{value(classification.fixAvailable)}</dd>
        <dt>Blocking findings</dt>
        <dd>{policy.blockingCount ?? "No data available"}</dd>
        <dt>Non-blocking findings</dt>
        <dd>{policy.warningCount ?? "No data available"}</dd>
      </dl>
      <p className="developer-note">This result and policy decision are persisted against Run ID {scan.pipelineRunId || "not available"}.</p>
    </section>
  );
}
