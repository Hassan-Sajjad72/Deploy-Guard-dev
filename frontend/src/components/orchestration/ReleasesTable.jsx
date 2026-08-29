function formatDate(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "-";
}

export default function ReleasesTable({ releases = [] }) {
  return (
    <section className="panel">
      <h2>Releases</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Commit</th>
              <th>Status</th>
              <th>Task Definition</th>
              <th>Deployed</th>
            </tr>
          </thead>
          <tbody>
            {releases.map((release) => (
              <tr key={release.id}>
                <td>{release.shortCommitSha}</td>
                <td>{release.status}</td>
                <td className="wrap-cell">{release.taskDefinitionArn}</td>
                <td>{formatDate(release.deployedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {releases.length === 0 ? <p className="muted">No releases yet.</p> : null}
    </section>
  );
}
