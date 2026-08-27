import { formatDuration, formatLocalDateTime, formatRelativeTime } from "../../utils/time";

export default function OrchestrationEventsTimeline({ events = [] }) {
  return (
    <section className="panel">
      <h2>Orchestration Events</h2>
      <ul className="timeline">
        {events.map((event) => (
          <li className="timeline-item" key={event.id}>
            <div>
              <strong>{event.eventType?.replaceAll("_", " ")}</strong>
              <p>{event.message}</p>
              <p className="muted">{event.status}</p>
            </div>
            <span className="event-time">
              <span>{formatLocalDateTime(event.occurredAt || event.createdAt)}</span>
              <small>{formatRelativeTime(event.occurredAt || event.createdAt)}</small>
              {event.durationMs != null ? <small>Duration: {formatDuration(event.durationMs)}</small> : null}
            </span>
          </li>
        ))}
      </ul>
      {events.length === 0 ? <p className="muted">No orchestration events yet.</p> : null}
    </section>
  );
}
