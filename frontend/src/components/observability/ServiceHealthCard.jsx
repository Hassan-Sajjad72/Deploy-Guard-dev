export default function ServiceHealthCard({ health }) {
  return (
    <section className="panel">
      <h2>Service Health</h2>
      <dl className="details-list">
        <dt>ECS</dt>
        <dd>{health?.latestEcsStatus || "-"}</dd>
        <dt>ALB</dt>
        <dd>{health?.latestAlbHealth?.status || "-"}</dd>
        <dt>Healthy Targets</dt>
        <dd>{health?.latestAlbHealth?.healthyCount ?? "-"}</dd>
        <dt>Unhealthy Targets</dt>
        <dd>{health?.latestAlbHealth?.unhealthyCount ?? "-"}</dd>
      </dl>
    </section>
  );
}
