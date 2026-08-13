function value(value) {
  return value === null || value === undefined || value === "" ? "-" : value;
}

export default function TerraformStateStatusCard({ state }) {
  return (
    <section className="panel">
      <h2>Terraform State</h2>
      {state ? (
        <dl className="details-list">
          <dt>Status</dt>
          <dd>
            <span className={`status-pill status-${state.status}`}>
              {state.status?.replaceAll("_", " ")}
            </span>
          </dd>
          <dt>Bucket</dt>
          <dd>{value(state.stateBucket)}</dd>
          <dt>Key</dt>
          <dd>{value(state.stateKey)}</dd>
          <dt>Version</dt>
          <dd>{value(state.currentVersionId)}</dd>
          <dt>Checksum</dt>
          <dd>{value(state.checksum)}</dd>
          <dt>Resources</dt>
          <dd>{value(state.resourceCount)}</dd>
        </dl>
      ) : (
        <p className="muted">No Terraform state metadata has been recorded yet.</p>
      )}
    </section>
  );
}
