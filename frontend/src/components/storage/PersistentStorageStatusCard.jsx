function value(value) {
  return value === null || value === undefined || value === "" ? "-" : value;
}

export default function PersistentStorageStatusCard({ storage }) {
  return (
    <section className="panel">
      <h2>Persistent Storage</h2>
      {storage ? (
        <dl className="details-list">
          <dt>Status</dt>
          <dd>
            <span className={`status-pill status-${storage.status}`}>
              {storage.status?.replaceAll("_", " ")}
            </span>
          </dd>
          <dt>Enabled</dt>
          <dd>{storage.enabled ? "Yes" : "No"}</dd>
          <dt>Required By Detection</dt>
          <dd>{storage.requiredByDetection ? "Yes" : "No"}</dd>
          <dt>Type</dt>
          <dd>{value(storage.storageType)}</dd>
          <dt>Region</dt>
          <dd>{value(storage.awsRegion)}</dd>
          <dt>Error</dt>
          <dd>{value(storage.errorMessage)}</dd>
        </dl>
      ) : (
        <p className="muted">Persistent storage has not been configured yet.</p>
      )}
    </section>
  );
}
