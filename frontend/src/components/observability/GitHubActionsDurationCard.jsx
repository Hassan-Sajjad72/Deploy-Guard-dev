export default function GitHubActionsDurationCard({ workflow }) {
  const started = workflow?.run_started_at || workflow?.created_at;
  const completed = workflow?.updated_at;
  const duration = started && completed ? new Date(completed).getTime() - new Date(started).getTime() : null;

  return (
    <section className="panel">
      <h2>Optional External CI</h2>
      <dl className="details-list">
        <dt>Status</dt>
        <dd>{workflow?.status || "-"}</dd>
        <dt>Conclusion</dt>
        <dd>{workflow?.conclusion || "-"}</dd>
        <dt>Branch</dt>
        <dd>{workflow?.head_branch || "-"}</dd>
        <dt>Commit</dt>
        <dd>{workflow?.head_sha?.slice?.(0, 12) || "-"}</dd>
        <dt>Duration</dt>
        <dd>{duration ? `${(duration / 1000).toFixed(1)} s` : "-"}</dd>
        <dt>Run</dt>
        <dd>{workflow?.html_url ? <a href={workflow.html_url} rel="noreferrer" target="_blank">Open</a> : "-"}</dd>
      </dl>
    </section>
  );
}
