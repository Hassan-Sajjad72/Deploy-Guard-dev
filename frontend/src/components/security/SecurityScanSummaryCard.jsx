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
        <dt>Policy Reason</dt>
        <dd>{value(scan.policyReason)}</dd>
        <dt>Application dependencies</dt>
        <dd>{value(classification.appDependency)}</dd>
        <dt>Base image / OS</dt>
        <dd>{(classification.baseImage || 0) + (classification.osPackage || 0)}</dd>
        <dt>Fix available</dt>
        <dd>{value(classification.fixAvailable)}</dd>
        <dt>Blocking / warning</dt>
        <dd>{value(policy.blockingCount)} / {value(policy.warningCount)}</dd>
        <dt>Approved By</dt>
        <dd>{value(scan.approvedByUserId)}</dd>
        <dt>Approval Reason</dt>
        <dd>{value(scan.approvalReason)}</dd>
      </dl>
      <p className="developer-note">Default policy blocks fixable Critical application dependencies. Base-image/OS and no-fix findings remain warnings unless stricter backend policy is enabled.</p>
    </section>
  );
}
