import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getApplicationLogs, getProjectCurrentState } from "../api/projectApi.js";
import EmptyState from "../components/common/EmptyState.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { PageHeader } from "../components/common/Premium.jsx";

export default function ProjectLogs() {
  const { projectId } = useParams();
  const [limit, setLimit] = useState(50);
  const [result, setResult] = useState(null);
  const [stableRelease, setStableRelease] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const state = await getProjectCurrentState(projectId);
      setStableRelease(state.stableRelease || null);
      setResult(state.stableRelease ? await getApplicationLogs(projectId, { limit }) : null);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setLoading(false);
    }
  }, [limit, projectId]);

  useEffect(() => { void load(); }, [load]);

  return <div className="page-stack">
    <PageHeader eyebrow="Application" title="Logs" description="Recent sanitized output from the verified stable application." actions={<Link className="secondary-button" to={`/projects/${projectId}`}>Overview</Link>} />
    {error ? <ErrorState message={error} onRetry={load} /> : null}
    {loading ? <LoadingState message="Loading application logs…" /> : null}
    {!loading && !error && !stableRelease ? <EmptyState message="Application logs will be available after the first stable release." /> : null}
    {!loading && stableRelease ? <>
      <section className="panel-flat application-log-controls">
        <label className="field"><span>Recent entries</span><select onChange={(event) => setLimit(Number(event.target.value))} value={limit}><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></label>
        <button className="secondary-button" onClick={load} type="button">Refresh</button>
      </section>
      {result?.available === false ? <EmptyState message={result.message || "Application logs are not available yet."} /> : null}
      {result?.available && !result.events?.length ? <EmptyState message="No application log entries were found." /> : null}
      {result?.events?.length ? <section className="panel-flat"><h2>Recent output</h2><div className="application-log-list">{result.events.map((event, index) => <div className="application-log-line" key={`${event.timestamp}-${index}`}><time>{new Date(event.timestamp).toLocaleString()}</time><pre>{event.message}</pre></div>)}</div></section> : null}
    </> : null}
  </div>;
}
