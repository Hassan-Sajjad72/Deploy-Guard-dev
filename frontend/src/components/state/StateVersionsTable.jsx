export default function StateVersionsTable({ onRecover, versions = [] }) {
  return (
    <section className="panel">
      <h2>State Versions</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Latest</th>
              <th>Last Modified</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((version, index) => (
              <tr key={version.VersionId || index}>
                <td className="wrap-cell">{version.VersionId || "-"}</td>
                <td>{version.IsLatest ? "yes" : "no"}</td>
                <td>{version.LastModified || "-"}</td>
                <td>
                  {version.VersionId ? (
                    <button className="secondary-button" onClick={() => onRecover(version.VersionId)} type="button">
                      Restore
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
            {versions.length === 0 ? (
              <tr>
                <td colSpan="4">No S3 state versions available.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
