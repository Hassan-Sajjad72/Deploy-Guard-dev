export default function DeploymentUrlCard({ deployment }) {
  const url = deployment?.albDnsName ? `http://${deployment.albDnsName}` : null;

  return (
    <section className="panel">
      <h2>Deployment URL</h2>
      {url ? <a className="ghost-button" href={url} rel="noreferrer" target="_blank">{url}</a> : <p className="muted">ALB URL appears after deployment.</p>}
      <p className="muted">Health check: {deployment?.healthCheckPath || "/health"}</p>
    </section>
  );
}
