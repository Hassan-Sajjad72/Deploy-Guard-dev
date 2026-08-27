import { useState } from "react";

export default function RestoreRequestPanel({ canManage, onRequest, storage }) {
  const [reason, setReason] = useState("");
  const [recoveryPointArn, setRecoveryPointArn] = useState("");

  function submit(event) {
    event.preventDefault();
    onRequest({
      persistentStorageId: storage?.id,
      recoveryPointArn: recoveryPointArn || undefined,
      reason: reason || undefined,
    });
    setReason("");
    setRecoveryPointArn("");
  }

  return (
    <section className="panel">
      <h2>Restore Request</h2>
      {canManage ? (
        <form className="form-stack" onSubmit={submit}>
          <label>
            Recovery point ARN
            <input
              onChange={(event) => setRecoveryPointArn(event.target.value)}
              placeholder="Optional"
              type="text"
              value={recoveryPointArn}
            />
          </label>
          <label>
            Reason
            <textarea
              onChange={(event) => setReason(event.target.value)}
              placeholder="Optional"
              value={reason}
            />
          </label>
          <button className="secondary-button" disabled={!storage?.id} type="submit">
            Request Restore
          </button>
        </form>
      ) : (
        <p className="muted">Readonly users cannot request restores.</p>
      )}
    </section>
  );
}
