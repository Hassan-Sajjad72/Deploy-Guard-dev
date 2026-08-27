function fmt(ms) {
  if (ms === null || ms === undefined) return "-";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export default function PipelineMetricsTimeline({ metrics = [] }) {
  return (
    <section className="panel">
      <h2>Pipeline Timeline</h2>
      {metrics.length === 0 ? <p className="muted">No stage metrics yet.</p> : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Stage</th>
              <th>Source</th>
              <th>Status</th>
              <th>Started</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((metric) => (
              <tr key={metric.id || metric.stageName}>
                <td>{metric.stageName?.replaceAll("_", " ")}</td>
                <td>{metric.source}</td>
                <td><span className={`status-pill status-${metric.status}`}>{metric.status}</span></td>
                <td>{metric.startedAt ? new Date(metric.startedAt).toLocaleString() : "-"}</td>
                <td>{fmt(metric.durationMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
