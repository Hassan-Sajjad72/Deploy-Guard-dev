function value(value) {
  return value === null || value === undefined || value === "" ? "-" : value;
}

export default function EcsDeploymentStatusCard({ deployment }) {
  const stability = deployment?.metadata?.ecsStability || {};
  const diagnostics = stability.diagnostics || {};

  return (
    <section className="panel">
      <h2>ECS Deployment</h2>
      {deployment ? (
        <dl className="details-list">
          <dt>Status</dt>
          <dd>
            <span className={`status-pill status-${deployment.status}`}>
              {deployment.status?.replaceAll("_", " ")}
            </span>
          </dd>
          <dt>Cluster</dt>
          <dd>{value(deployment.ecsClusterName)}</dd>
          <dt>Service</dt>
          <dd>{value(deployment.ecsServiceName)}</dd>
          <dt>Commit</dt>
          <dd>{value(deployment.shortCommitSha || deployment.commitSha)}</dd>
          <dt>Image</dt>
          <dd>{value(deployment.imageUri)}</dd>
          <dt>Task Definition</dt>
          <dd>{value(deployment.taskDefinitionArn)}</dd>
          <dt>Stable</dt>
          <dd>{deployment.stable ? "Yes" : "No"}</dd>
          <dt>Desired</dt>
          <dd>{value(stability.desiredCount)}</dd>
          <dt>Running</dt>
          <dd>{value(stability.runningCount)}</dd>
          <dt>Pending</dt>
          <dd>{value(stability.pendingCount)}</dd>
          <dt>Rollout</dt>
          <dd>{value(stability.rolloutState)}</dd>
          <dt>Last Check</dt>
          <dd>{value(stability.checkedAt)}</dd>
          <dt>Reason</dt>
          <dd>{value(stability.reason)}</dd>
          {diagnostics.summary ? <>
            <dt>Diagnostic</dt>
            <dd><strong>{diagnostics.summary}</strong></dd>
            <dt>Stopped task</dt>
            <dd>{value(diagnostics.lastStoppedTaskArn)}</dd>
            <dt>Container exit</dt>
            <dd>{value(diagnostics.containerExitCode)}</dd>
            <dt>Ports</dt>
            <dd>Container {value(diagnostics.containerPort)} · target {value(diagnostics.targetPort)}</dd>
            <dt>Health check</dt>
            <dd>{value(diagnostics.healthCheckPath)}</dd>
            <dt>CloudWatch stream</dt>
            <dd>{value(diagnostics.logStreamName)}</dd>
          </> : null}
        </dl>
      ) : (
        <p className="muted">No ECS deployment has been recorded yet.</p>
      )}
      {diagnostics.logLines?.length ? <details><summary>Recent sanitized CloudWatch lines</summary><pre className="metadata">{diagnostics.logLines.join("\n")}</pre></details> : null}
    </section>
  );
}
