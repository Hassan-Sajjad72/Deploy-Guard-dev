function valueOrDash(value) {
  return value || "—";
}

function label(value) {
  return String(value || "unknown").replaceAll("_", " ");
}

function timestamp(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
}

const eventLabels = {
  prepared: "Prepared",
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  cancelled: "Cancelled",
  blocked: "Blocked",
};

/** Displays only the sanitized current-state release-lane projection. */
export default function ReleaseLaneDeveloperDetails({ releaseLane }) {
  const intent = releaseLane?.intent;
  const events = Array.isArray(intent?.events)
    ? intent.events.filter((event) => event && eventLabels[event.kind] && typeof event.code === "string" && typeof event.occurredAt === "string").slice(-4)
    : [];
  return <section className="release-lane-developer-details" aria-label="Release lane details">
    <p className="eyebrow">V1 release lane</p>
    <dl className="developer-detail-grid">
      <div><dt>Status</dt><dd>{label(releaseLane?.state)}</dd></div>
      <div><dt>Lifecycle code</dt><dd>{valueOrDash(intent?.lifecycleCode || releaseLane?.safeCodes?.[0])}</dd></div>
      <div><dt>Intent reference</dt><dd>{valueOrDash(intent?.safeId)}</dd></div>
      <div><dt>Candidate release</dt><dd>{valueOrDash(intent?.releaseManifestRevision)}</dd></div>
      <div><dt>Outbox state</dt><dd>{valueOrDash(intent?.outboxStatus)}</dd></div>
      <div><dt>Source commit</dt><dd>{valueOrDash(intent?.sourceCommitShortSha)}</dd></div>
      <div><dt>Last activity</dt><dd>{timestamp(intent?.lastMeaningfulAt)}</dd></div>
    </dl>
    <section className="release-lane-event-card" aria-label="Latest release-lane events">
      <p className="eyebrow">Latest intent events</p>
      {events.length ? <ol>{events.map((event) => <li key={`${event.kind}:${event.occurredAt}`}><strong>{eventLabels[event.kind]}</strong><small>{event.code}</small><span>{timestamp(event.occurredAt)}</span></li>)}</ol> : <p>No sanitized release-lane events are available.</p>}
    </section>
  </section>;
}
