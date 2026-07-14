function formatDate(value) {
  return value
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "-";
}

export default function StateLockStatusCard({ canForceRelease, lock, onForceRelease }) {
  return (
    <section className="panel">
      <h2>State Lock</h2>
      {lock ? (
        <div className="form-stack">
          <dl className="details-list">
            <dt>Status</dt>
            <dd>
              <span className={`status-pill status-${lock.status}`}>
                {lock.status?.replaceAll("_", " ")}
              </span>
            </dd>
            <dt>Lock ID</dt>
            <dd>{lock.lockId}</dd>
            <dt>Pipeline Run</dt>
            <dd>{lock.pipelineRunId}</dd>
            <dt>Heartbeat</dt>
            <dd>{formatDate(lock.heartbeatAt)}</dd>
            <dt>Owner Worker</dt>
            <dd>{lock.ownerWorkerId || "-"}</dd>
          </dl>
          {canForceRelease ? (
            <button className="danger-button" onClick={() => onForceRelease(lock.lockId)} type="button">
              Force Release
            </button>
          ) : null}
        </div>
      ) : (
        <p className="muted">No active lock has been recorded.</p>
      )}
    </section>
  );
}
