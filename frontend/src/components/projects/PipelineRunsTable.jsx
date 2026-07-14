function formatDate(value) {
  return value ? new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value)) : "-";
}

function shortSha(run) {
  return run.shortCommitSha || (run.commitSha ? run.commitSha.slice(0, 12) : "-");
}

export default function PipelineRunsTable({ runs, selectedRunId, onSelect }) {
  return (
    <section className="panel">
      <div className="page-header">
        <div>
          <h2>Pipeline Runs</h2>
          <p className="muted">{runs.length} runs</p>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Stage</th>
              <th>Branch</th>
              <th>Commit</th>
              <th>Image Tag</th>
              <th>ECR Image</th>
              <th>Created</th>
              <th>Completed</th>
              <th><span className="sr-only">Select run</span></th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr aria-current={run.id === selectedRunId ? "true" : undefined} className={run.id === selectedRunId ? "selected-row" : ""} key={run.id}>
                <td>
                  <span className={`status-pill status-${run.status}`}>
                    {run.status}
                  </span>
                </td>
                <td>{run.currentStage || "-"}</td>
                <td>{run.targetBranch || "-"}</td>
                <td>{shortSha(run)}</td>
                <td className="wrap-cell">{run.imageTag || "-"}</td>
                <td className="wrap-cell">{run.ecrImageUri || "-"}</td>
                <td>{formatDate(run.createdAt)}</td>
                <td>{formatDate(run.completedAt)}</td>
                <td><button aria-label={`View run ${run.id.slice(0, 8)}`} className="subtle-button" onClick={() => onSelect(run)} type="button">View</button></td>
              </tr>
            ))}
            {runs.length === 0 ? (
              <tr>
                <td colSpan="9">No pipeline runs yet.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
