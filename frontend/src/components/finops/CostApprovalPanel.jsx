import { useState } from "react";

export default function CostApprovalPanel({ canManage, estimate, onApprove, onReject }) {
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!estimate || estimate.status !== "approval_required") {
    return null;
  }

  async function submit(action) {
    setIsSubmitting(true);

    try {
      if (action === "approve") {
        await onApprove();
      } else {
        await onReject(reason);
      }
      setReason("");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="panel">
      <h2>Cost Approval</h2>
      {canManage ? (
        <div className="form-stack">
          <label className="field">
            <span>Rejection reason</span>
            <input
              onChange={(event) => setReason(event.target.value)}
              value={reason}
            />
          </label>
          <div className="quick-actions">
            <button
              className="button"
              disabled={isSubmitting}
              onClick={() => submit("approve")}
              type="button"
            >
              Approve
            </button>
            <button
              className="danger-button"
              disabled={isSubmitting}
              onClick={() => submit("reject")}
              type="button"
            >
              Reject
            </button>
          </div>
        </div>
      ) : (
        <p className="muted">Readonly users can view approval state.</p>
      )}
    </section>
  );
}
