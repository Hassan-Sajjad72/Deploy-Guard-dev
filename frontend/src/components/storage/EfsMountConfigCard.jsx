export default function EfsMountConfigCard({ mountConfig }) {
  return (
    <section className="panel">
      <h2>ECS Mount Config</h2>
      {mountConfig ? (
        <pre className="code-block">{JSON.stringify(mountConfig, null, 2)}</pre>
      ) : (
        <p className="muted">Mount config is available after EFS is provisioned.</p>
      )}
    </section>
  );
}
