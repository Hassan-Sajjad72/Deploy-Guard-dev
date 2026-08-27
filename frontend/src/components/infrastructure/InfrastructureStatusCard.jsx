function value(value) {
  return value === null || value === undefined || value === "" ? "-" : value;
}

export default function InfrastructureStatusCard({ environment }) {
  return (
    <section className="panel">
      <h2>Infrastructure</h2>
      {environment ? (
        <dl className="details-list">
          <dt>Status</dt>
          <dd>
            <span className={`status-pill status-${environment.status}`}>
              {environment.status?.replaceAll("_", " ")}
            </span>
          </dd>
          <dt>AWS Region</dt>
          <dd>{value(environment.awsRegion)}</dd>
          <dt>VPC</dt>
          <dd>{value(environment.vpcId)}</dd>
          <dt>Public Subnets</dt>
          <dd>{(environment.publicSubnetIds || []).join(", ") || "-"}</dd>
          <dt>Private Subnets</dt>
          <dd>{(environment.privateSubnetIds || []).join(", ") || "-"}</dd>
          <dt>Cloud Map</dt>
          <dd>{value(environment.cloudMapNamespaceName)}</dd>
          <dt>Error</dt>
          <dd>{value(environment.errorMessage)}</dd>
        </dl>
      ) : (
        <p className="muted">Infrastructure has not been provisioned yet.</p>
      )}
    </section>
  );
}
