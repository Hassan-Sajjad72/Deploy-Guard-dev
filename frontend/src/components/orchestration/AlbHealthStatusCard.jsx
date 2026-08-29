function value(value) {
  return value === null || value === undefined || value === "" ? "-" : value;
}

export default function AlbHealthStatusCard({ targetHealth }) {
  const targetStates = targetHealth?.targetStates || [];

  return (
    <section className="panel">
      <h2>ALB Health</h2>
      <dl className="details-list">
        <dt>Status</dt>
        <dd>{value(targetHealth?.status)}</dd>
        <dt>Health Path</dt>
        <dd>{value(targetHealth?.healthCheckPath)}</dd>
        <dt>Target Group</dt>
        <dd>{value(targetHealth?.targetGroupArn)}</dd>
        <dt>ALB DNS</dt>
        <dd>{value(targetHealth?.albDnsName)}</dd>
        <dt>Healthy Targets</dt>
        <dd>{value(targetHealth?.healthyCount)}</dd>
        <dt>Unhealthy Targets</dt>
        <dd>{value(targetHealth?.unhealthyCount)}</dd>
        <dt>Reason</dt>
        <dd>{value(targetHealth?.reason)}</dd>
        <dt>Targets</dt>
        <dd>
          {targetStates.length > 0 ? (
            <ul className="compact-list">
              {targetStates.map((target, index) => (
                <li key={`${target.targetId || "target"}-${target.port || "port"}-${index}`}>
                  {value(target.targetId)}:{value(target.port)} - {value(target.state)}
                </li>
              ))}
            </ul>
          ) : (
            "-"
          )}
        </dd>
      </dl>
    </section>
  );
}
