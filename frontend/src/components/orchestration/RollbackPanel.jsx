import { useState } from "react";

export default function RollbackPanel({ canManage, hasRelease, onRollback }) {
  const [reason, setReason] = useState("");

  function submit(event) {
    event.preventDefault();
    if (!window.confirm("Rollback this deployment to the latest stable release? This changes the active ECS release.")) return;
    onRollback(reason || "Manual rollback requested.");
    setReason("");
  }

  return (
    <section className="panel">
      <h2>Rollback to Stable Release</h2>
      {canManage ? (
        <form className="form-stack" onSubmit={submit}>
          <label className="field">
            <span>Reason</span>
            <textarea onChange={(event) => setReason(event.target.value)} value={reason} />
          </label>
          <button className="danger-button" disabled={!hasRelease} type="submit">Rollback to Stable Release</button>
        </form>
      ) : (
        <p className="muted">Readonly users cannot rollback deployments.</p>
      )}
    </section>
  );
}
