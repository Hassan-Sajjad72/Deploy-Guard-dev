export default function ObservabilityStatusBanner({ summary, runtime }) {
  return (
    <section className="panel">
      <h2>Observability Status</h2>
      <dl className="details-list">
        <dt>Prometheus</dt>
        <dd>{summary?.prometheus?.message || (runtime?.enabled === false ? runtime.message : runtime?.source || "-")}</dd>
        <dt>CloudWatch Logs</dt>
        <dd>{summary?.cloudWatchFallback?.logsEnabled ? "enabled" : "disabled"}</dd>
        <dt>CloudWatch Metrics</dt>
        <dd>{summary?.cloudWatchFallback?.metricsEnabled ? "enabled" : "disabled"}</dd>
        <dt>Deployment</dt>
        <dd>{summary?.latestDeploymentStatus || "-"}</dd>
      </dl>
    </section>
  );
}
