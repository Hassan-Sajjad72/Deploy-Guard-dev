function value(value) {
  return value === null || value === undefined || value === "" ? "-" : value;
}

export default function StableReleaseCard({ release }) {
  return (
    <section className="panel">
      <h2>Stable Release</h2>
      {release ? (
        <dl className="details-list">
          <dt>Commit</dt>
          <dd>{value(release.shortCommitSha || release.commitSha)}</dd>
          <dt>Status</dt>
          <dd>{value(release.status)}</dd>
          <dt>Image</dt>
          <dd>{value(release.imageUri)}</dd>
          <dt>Task Definition</dt>
          <dd>{value(release.taskDefinitionArn)}</dd>
        </dl>
      ) : (
        <p className="muted">No stable release has been saved yet.</p>
      )}
    </section>
  );
}
