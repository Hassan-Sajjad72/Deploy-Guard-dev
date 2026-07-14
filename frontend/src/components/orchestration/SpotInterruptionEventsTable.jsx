function formatDate(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "-";
}

export default function SpotInterruptionEventsTable({ events = [] }) {
  return (
    <section className="panel">
      <h2>Spot Interruptions</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Task</th>
              <th>Reason</th>
              <th>Received</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td>{event.status}</td>
                <td className="wrap-cell">{event.taskArn || "-"}</td>
                <td>{event.reason || "-"}</td>
                <td>{formatDate(event.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {events.length === 0 ? <p className="muted">No spot interruption events yet.</p> : null}
    </section>
  );
}
