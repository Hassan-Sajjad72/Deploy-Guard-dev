export default function DeployButton({
  canManage,
  isDeploying,
  onDeploy,
  readiness,
}) {
  const disabled = !canManage || !readiness?.ready || isDeploying;
  const label = isDeploying
    ? "Deployment queued"
    : readiness?.ready
      ? "Deploy to AWS"
      : "Deploy to AWS";

  return (
    <div className="form-stack">
      <button className="button" disabled={disabled} onClick={onDeploy} type="button">
        {label}
      </button>
      {!canManage ? <p className="muted">Readonly users cannot deploy.</p> : null}
      {!readiness?.ready && readiness?.nextRequiredAction ? (
        <p className="error">{readiness.nextRequiredAction}</p>
      ) : null}
    </div>
  );
}
