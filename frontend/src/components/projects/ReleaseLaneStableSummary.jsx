function timestamp(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
}

/** Public, sanitized stable-release summary from the authoritative current-state response. */
export default function ReleaseLaneStableSummary({ releaseLane }) {
  const stable = releaseLane?.stableRelease;
  if (!stable || stable.status !== "stable") return null;
  return <section className="project-live-card panel-flat" aria-label="Current stable release">
    <div className="live-card-status"><span /><strong>Current stable release</strong></div>
    <h2>Release {stable.revision}</h2>
    <p>Commit {stable.sourceCommitShortSha} · stable</p>
    <small>Promoted {timestamp(stable.promotedAt)}</small>
    {stable.url ? <a className="secondary-button" href={stable.url} rel="noreferrer" target="_blank">Open stable release</a> : null}
    {stable.rollbackLineage ? <p className="rollback-lineage">Rollback lineage: release {stable.rollbackLineage.revision} · {stable.rollbackLineage.sourceCommitShortSha}</p> : null}
  </section>;
}
