function fmt(ms) {
  if (!ms) return "-";
  return `${(ms / 1000).toFixed(1)} s`;
}

export default function StageDurationChart({ metrics = [] }) {
  const max = Math.max(...metrics.map((metric) => metric.durationMs || 0), 1);

  return (
    <section className="panel">
      <h2>Stage Durations</h2>
      <div className="bar-list">
        {metrics.map((metric) => (
          <div className="bar-row" key={metric.id || metric.stageName}>
            <span>{metric.stageName?.replaceAll("_", " ")}</span>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${Math.max(4, ((metric.durationMs || 0) / max) * 100)}%` }} />
            </div>
            <strong>{fmt(metric.durationMs)}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}
