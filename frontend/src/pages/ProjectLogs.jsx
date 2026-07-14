import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getObservabilityLogs, getProjectCurrentState } from "../api/projectApi.js";
import EmptyState from "../components/common/EmptyState.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { PageHeader } from "../components/common/Premium.jsx";
import EcsLogsStream from "../components/observability/EcsLogsStream.jsx";
import LogFilterBar from "../components/observability/LogFilterBar.jsx";

export default function ProjectLogs() {
  const { projectId } = useParams();
  const [filters, setFilters] = useState({ limit: 50, stream: "all" });
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState("");
  const [hasRuntime, setHasRuntime] = useState(null);

  function refresh() {
    setError("");
    getObservabilityLogs(projectId, filters)
      .then((data) => setLogs(data.events || []))
      .catch((err) => setError(err.message));
  }

  useEffect(() => {
    setHasRuntime(null);
    getProjectCurrentState(projectId)
      .then((state) => {
        setHasRuntime(Boolean(state.hasRealDeployment));
        if (state.hasRealDeployment) refresh();
      })
      .catch((err) => {
        setHasRuntime(false);
        setError(err.message);
      });
  }, [projectId]);

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Live Deployment Logs"
        title="Sanitized Log Stream"
        description="CloudWatch log events and live SSE stream with filtering. Secret values are not rendered."
        actions={<Link className="secondary-button" to={`/projects/${projectId}/observability`}>Overview</Link>}
      />
      {error ? <ErrorState message={error} /> : null}
      {hasRuntime === null ? <LoadingState message="Checking deployment status..." /> : null}
      {hasRuntime === false && !error ? <EmptyState message="Runtime will be available after deployment." /> : null}
      {hasRuntime ? <><LogFilterBar filters={filters} onChange={setFilters} onRefresh={refresh} />
      <EcsLogsStream filters={filters} projectId={projectId} />
      <section className="panel">
        <h2>Recent Logs</h2>
        <pre className="log-output">{logs.map((line) => `[${line.timestamp}] ${line.message}`).join("\n")}</pre>
      </section></> : null}
    </div>
  );
}
