export default function DeploymentQueuePanel({ queue = [] }) {
  return (
    <section className="panel">
      <h2>Project Queue</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Position</th>
              <th>Status</th>
              <th>Pipeline Run</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {queue.map((item) => (
              <tr key={item.id}>
                <td>{item.position || "-"}</td>
                <td>{item.status}</td>
                <td className="wrap-cell">{item.pipelineRunId}</td>
                <td>{item.reason || "-"}</td>
              </tr>
            ))}
            {queue.length === 0 ? (
              <tr>
                <td colSpan="4">No queued deployments.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
