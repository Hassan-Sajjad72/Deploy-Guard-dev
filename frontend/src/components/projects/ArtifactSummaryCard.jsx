function valueOrDash(value) {
  return value === null || value === undefined || value === "" ? "-" : value;
}

export default function ArtifactSummaryCard({ run }) {
  if (!run) {
    return (
      <section className="panel">
        <h2>Artifacts</h2>
        <p className="muted">Select a run to view generated artifact metadata.</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Artifacts</h2>
      <dl className="details-list">
        <dt>Commit SHA</dt>
        <dd>{valueOrDash(run.commitSha)}</dd>
        <dt>Short Commit SHA</dt>
        <dd>{valueOrDash(run.shortCommitSha)}</dd>
        <dt>Image Name</dt>
        <dd>{valueOrDash(run.imageName)}</dd>
        <dt>Image Tag</dt>
        <dd>{valueOrDash(run.imageTag)}</dd>
        <dt>ECR Repository</dt>
        <dd>{valueOrDash(run.ecrRepositoryName)}</dd>
        <dt>ECR Image URI</dt>
        <dd>{valueOrDash(run.ecrImageUri)}</dd>
        <dt>GitHub Workflow</dt>
        <dd>{valueOrDash(run.githubWorkflowStatus)}</dd>
        {run.errorMessage ? (
          <>
            <dt>Error</dt>
            <dd className="error">{run.errorMessage}</dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}
