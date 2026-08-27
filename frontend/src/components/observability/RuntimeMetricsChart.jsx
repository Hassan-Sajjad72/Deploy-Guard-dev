export default function RuntimeMetricsChart({ title, metric }) {
  const points = metric?.points || [];
  const max = Math.max(...points.map((point) => Number(point.value || 0)), 1);

  return (
    <section className="panel">
      <h2>{title}</h2>
      {points.length === 0 ? <p className="muted">No metric points available.</p> : null}
      <div className="sparkline" aria-label={title}>
        {points.slice(-40).map((point, index) => (
          <span
            key={`${point.timestamp}-${index}`}
            title={`${point.timestamp}: ${point.value}`}
            style={{ height: `${Math.max(6, (Number(point.value || 0) / max) * 90)}%` }}
          />
        ))}
      </div>
    </section>
  );
}
