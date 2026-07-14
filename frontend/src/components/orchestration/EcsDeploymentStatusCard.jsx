function value(value) {
  return value === null || value === undefined || value === "" ? "-" : value;
}

export default function EcsDeploymentStatusCard({ deployment }) {
  const stability = deployment?.metadata?.ecsStability || {};

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
        </dl>
      ) : (
        <p className="muted">No ECS deployment has been recorded yet.</p>
      )}
    </section>
  );
}
