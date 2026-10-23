export default function StartPipelineForm({
  canManage,
  isStarting,
  onStart,
  options,
  setOptions,
}) {
  function updateOption(key) {
    setOptions((current) => ({ ...current, [key]: !current[key] }));
  }

  return (
    <section className="panel">
      <div className="page-header">
        <div>
          <h2>Start Pipeline</h2>
          <p className="muted">
            {canManage
              ? "Queue a CI/CD run for the selected project branch."
              : "Readonly users can view pipeline history."}
          </p>
        </div>
        {canManage ? (
          <button
            className="button"
            disabled={isStarting}
            onClick={onStart}
            type="button"
          >
            {isStarting ? "Queueing..." : "Start Pipeline"}
          </button>
        ) : null}
      </div>

      <div className="option-grid">
        <label className="check-row">
          <input
            checked={options.triggerGithubActions}
            disabled={!canManage || isStarting}
            onChange={() => updateOption("triggerGithubActions")}
            type="checkbox"
          />
          <span>Trigger GitHub Actions workflow</span>
        </label>
        <label className="check-row">
          <input
            checked={options.buildImage}
            disabled={!canManage || isStarting}
            onChange={() => updateOption("buildImage")}
            type="checkbox"
          />
          <span>Build Docker image</span>
        </label>
        <label className="check-row">
          <input
            checked={options.pushToEcr}
            disabled={!canManage || isStarting}
            onChange={() => updateOption("pushToEcr")}
            type="checkbox"
          />
          <span>Push to ECR</span>
        </label>
      </div>
    </section>
  );
}
