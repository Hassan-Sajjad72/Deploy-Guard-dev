function formatDate(value) {
  return value
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "-";
}

export default function StorageEventsTimeline({ events = [] }) {
  return (
    <section className="panel">
      <h2>Storage Events</h2>
      <ul className="timeline">
        {events.map((event) => (
          <li className="timeline-item" key={event.id}>
            <div>
              <strong>{event.eventType?.replaceAll("_", " ")}</strong>
              <p>{event.message}</p>
              <p className="muted">{event.status}</p>
            </div>
            <span className="muted">{formatDate(event.createdAt)}</span>
          </li>
        ))}
      </ul>
      {events.length === 0 ? <p className="muted">No storage events yet.</p> : null}
    </section>
  );
}
