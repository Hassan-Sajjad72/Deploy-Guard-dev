import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getObservabilityLogs } from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import { PageHeader, ProjectQuickNav } from "../components/common/Premium.jsx";
import EcsLogsStream from "../components/observability/EcsLogsStream.jsx";
import LogFilterBar from "../components/observability/LogFilterBar.jsx";

export default function ProjectLogs() {
  const { projectId } = useParams();
  const [filters, setFilters] = useState({ limit: 50, stream: "all" });
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState("");

  function refresh() {
    setError("");
    getObservabilityLogs(projectId, filters)
      .then((data) => setLogs(data.events || []))
      .catch((err) => setError(err.message));
  }

  useEffect(() => {
    refresh();
  }, [projectId]);

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Live Deployment Logs"
        title="Sanitized Log Stream"
        description="CloudWatch log events and live SSE stream with filtering. Secret values are not rendered."
        actions={<Link className="secondary-button" to={`/projects/${projectId}/observability`}>Overview</Link>}
      />
      <ProjectQuickNav projectId={projectId} />
      {error ? <ErrorState message={error} /> : null}
      <LogFilterBar filters={filters} onChange={setFilters} onRefresh={refresh} />
      <EcsLogsStream filters={filters} projectId={projectId} />
      <section className="panel">
        <h2>Recent Logs</h2>
        <pre className="log-output">{logs.map((line) => `[${line.timestamp}] ${line.message}`).join("\n")}</pre>
      </section>
    </div>
  );
}
