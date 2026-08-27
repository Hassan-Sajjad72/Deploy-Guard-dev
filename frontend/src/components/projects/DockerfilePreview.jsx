export default function DockerfilePreview({ dockerfile, generatedDockerfile }) {
  if (dockerfile?.usesExistingDockerfile) {
    return (
      <section className="panel">
        <h2>Dockerfile Preview</h2>
        <p className="muted">
          This project already contains a Dockerfile. The platform will use the
          existing Dockerfile.
        </p>
      </section>
    );
  }

  if (dockerfile?.dockerfileRequired) {
    return (
      <section className="panel">
        <h2>Dockerfile Preview</h2>
        <div className="state error">
          No safe automatic template was found. Please provide a custom Dockerfile.
        </div>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Dockerfile Preview</h2>
      <pre className="metadata">{generatedDockerfile || dockerfile?.contentPreview}</pre>
    </section>
  );
}
