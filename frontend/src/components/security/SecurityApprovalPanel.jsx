import { useState } from "react";

export default function SecurityApprovalPanel({ canManage, onApprove, scan }) {
  const [reason, setReason] = useState("");
  const [isApproving, setIsApproving] = useState(false);

  if (scan.policyDecision !== "requires_approval") {
    return null;
  }

  async function submit(event) {
    event.preventDefault();
    setIsApproving(true);

    try {
      await onApprove(reason);
      setReason("");
    } finally {
      setIsApproving(false);
    }
  }

  return (
    <section className="panel">
      <h2>Manual Approval</h2>
      <p className="muted">Medium vulnerabilities exceeded the approval threshold.</p>
      {canManage ? (
        <form className="form-stack" onSubmit={submit}>
          <label className="field">
            <span>Approval reason</span>
            <input
              onChange={(event) => setReason(event.target.value)}
              placeholder="Reviewed accepted risk for staging"
              required
              value={reason}
            />
          </label>
          <button className="button" disabled={isApproving} type="submit">
            {isApproving ? "Approving..." : "Approve Scan"}
          </button>
        </form>
      ) : (
        <p className="muted">You can view this scan but cannot approve it.</p>
      )}
    </section>
  );
}
