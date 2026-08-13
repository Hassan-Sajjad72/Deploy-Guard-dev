export default function DeploymentReadinessChecklist({ readiness }) {
  const checks = readiness?.checks || [];

  return (
    <section className="panel">
      <h2>Deployment Readiness</h2>
      <div className="grid">
        {checks.map((check) => (
          <div className="check-row" key={check.key}>
            <span className={`status-pill status-${check.blocking ? "failed" : "completed"}`}>
              {check.status}
            </span>
            <div>
              <strong>{check.label}</strong>
              <p className="muted">{check.message}</p>
            </div>
          </div>
        ))}
        {checks.length === 0 ? <p className="muted">Readiness has not been checked yet.</p> : null}
      </div>
    </section>
  );
}
