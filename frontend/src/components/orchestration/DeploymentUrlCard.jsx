export default function DeploymentUrlCard({ deployment }) {
  const url = deployment?.albDnsName ? `http://${deployment.albDnsName}` : null;
  const healthy = ["healthy", "rollback_succeeded"].includes(deployment?.status);

  return (
    <section className="panel">
      <h2>Deployment URL</h2>
      {url ? <a className="ghost-button" href={url} rel="noreferrer" target="_blank">{url}</a> : <p className="muted">ALB URL appears after deployment.</p>}
      {url && !healthy ? <p className="state warning">Load balancer exists, but the application is not healthy yet.</p> : null}
      <p className="muted">Health check: {deployment?.healthCheckPath || "/health"}</p>
    </section>
  );
}
