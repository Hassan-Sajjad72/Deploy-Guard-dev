export default function StartPipelineForm({
  canManage,
  canStart = canManage,
  disabledReason,
  isStarting,
  onStart,
  safeMode = false,
}) {
  return (
    <section className="panel">
      <div className="page-header">
        <div>
          <h2>{safeMode ? "Start Safe Pipeline" : "Start Pipeline"}</h2>
          <p className="muted">
            {canManage
              ? canStart
                ? "DeployGuard clones, templates, builds, scans, estimates, and plans the selected project branch in its own worker."
                : disabledReason || "Complete the required setup steps before starting a pipeline."
              : "Readonly users can view pipeline history."}
          </p>
        </div>
        {canManage ? (
          <button
            className="button"
            disabled={isStarting || !canStart}
            onClick={onStart}
            type="button"
          >
            {isStarting ? "Queueing..." : safeMode ? "Start Safe Pipeline" : "Start Pipeline"}
          </button>
        ) : null}
      </div>

      {canStart ? <div className="option-grid">
        {[
          "Optional External CI",
          "Repository clone & stack snapshot",
          "Template generation",
          "Docker build",
          "Trivy scan",
          "ECR push",
          "ECR lifecycle policy",
          "Terraform stage",
        ].map((stage) => (
          <div className="check-row" key={stage}>
            <span>{stage}</span>
          </div>
        ))}
      </div> : null}
      {canStart ? <p className="muted">GitHub Actions is optional external validation. A missing workflow or insufficient dispatch permission does not block DeployGuard's internal pipeline unless the backend explicitly sets GITHUB_ACTIONS_REQUIRED=true.</p> : null}
    </section>
  );
}
