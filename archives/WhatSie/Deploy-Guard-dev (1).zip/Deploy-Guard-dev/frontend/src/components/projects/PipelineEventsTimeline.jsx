import { Link } from "react-router-dom";

function formatDate(value) {
  return value ? new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value)) : "-";
}

export default function PipelineEventsTimeline({ events, projectId }) {
  return (
    <section className="panel">
      <div className="page-header">
        <div>
          <h2>Events</h2>
          <p className="muted">Stage-by-stage worker progress.</p>
        </div>
      </div>
      <ol className="timeline">
        {events.map((event) => (
          <li className={`timeline-item event-${event.status}`} key={event.id}>
            <div>
              <strong>{event.stage}</strong>
              <p>{event.message}</p>
              {event.metadata?.ecrImageUri ? (
                <p className="muted wrap-cell">{event.metadata.ecrImageUri}</p>
              ) : null}
              {event.metadata?.scanId ? (
                <Link
                  className="ghost-button"
                  to={`/projects/${projectId}/security/scans/${event.metadata.scanId}`}
                >
                  View security scan
                </Link>
              ) : null}
            </div>
            <span className="muted">{formatDate(event.createdAt)}</span>
          </li>
        ))}
        {events.length === 0 ? (
          <li className="timeline-item">
            <p>No events for this run yet.</p>
          </li>
        ) : null}
      </ol>
    </section>
  );
}
