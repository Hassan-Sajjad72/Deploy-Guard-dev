import SecurityPolicyDecisionBadge from "./SecurityPolicyDecisionBadge.jsx";

function value(value) {
  return value === null || value === undefined || value === "" ? "-" : value;
}

export default function SecurityScanSummaryCard({ scan }) {
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
        <dt>Approved By</dt>
        <dd>{value(scan.approvedByUserId)}</dd>
        <dt>Approval Reason</dt>
        <dd>{value(scan.approvalReason)}</dd>
      </dl>
    </section>
  );
}
