import { StatusBadge, formatStatus } from "../common/Premium.jsx";
import { formatDuration, formatLocalDateTime, formatRelativeTime } from "../../utils/time.js";

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
              <div className="timeline-title-row">
                <strong>{formatStatus(event.stage)}</strong>
                <StatusBadge status={event.status} />
              </div>
              <p>{event.message}</p>
              {event.metadata?.ecrImageUri ? (
                <p className="muted wrap-cell">{event.metadata.ecrImageUri}</p>
              ) : null}
              {event.metadata?.shortCommitSha ? (
                <p className="muted">Commit: {event.metadata.shortCommitSha}</p>
              ) : null}
              {event.metadata?.terraformStatus ? (
                <p className="muted">Terraform: {event.metadata.terraformStatus}</p>
              ) : null}
            </div>
            <span className="event-time"><time dateTime={event.occurredAt || event.createdAt}>{formatLocalDateTime(event.occurredAt || event.createdAt)}</time><small>{formatRelativeTime(event.occurredAt || event.createdAt)}</small>{event.durationMs != null ? <small>Duration: {formatDuration(event.durationMs)}</small> : null}</span>
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
