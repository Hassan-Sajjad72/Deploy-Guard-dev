import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getObservabilityRuntimeMetrics, getProjectCurrentState } from "../api/projectApi.js";
import EmptyState from "../components/common/EmptyState.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { PageHeader } from "../components/common/Premium.jsx";
import AlbLatencyCard from "../components/observability/AlbLatencyCard.jsx";
import CpuMemoryChart from "../components/observability/CpuMemoryChart.jsx";
import ObservabilityStatusBanner from "../components/observability/ObservabilityStatusBanner.jsx";

export default function ProjectMetrics() {
  const { projectId } = useParams();
  const [source, setSource] = useState("auto");
  const [range, setRange] = useState("1h");
  const [runtime, setRuntime] = useState(null);
  const [error, setError] = useState("");
  const [hasRuntime, setHasRuntime] = useState(null);

  useEffect(() => {
    setRuntime(null);
    setHasRuntime(null);
    setError("");
    getProjectCurrentState(projectId)
      .then((state) => {
        const available = Boolean(state.hasRealDeployment);
        setHasRuntime(available);
        return available ? getObservabilityRuntimeMetrics(projectId, { source, range }) : null;
      })
      .then((response) => response && setRuntime(response))
      .catch((err) => setError(err.message));
  }, [projectId, source, range]);

  if (error) return <ErrorState message={error} />;

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Runtime Metrics"
        title="CPU, Memory, Latency"
        description="Prometheus telemetry with CloudWatch fallback and clear disabled states when metrics are unavailable."
        actions={<Link className="secondary-button" to={`/projects/${projectId}/observability`}>Overview</Link>}
      />
      {hasRuntime === null ? <LoadingState message="Checking deployment status..." /> : null}
      {hasRuntime === false ? <EmptyState message="Runtime will be available after deployment." /> : null}
      {hasRuntime ? <><section className="panel">
        <h2>Metric Source</h2>
        <div className="button-row">
          {["auto", "prometheus", "cloudwatch"].map((item) => (
            <button className={source === item ? "primary-button" : "secondary-button"} key={item} onClick={() => setSource(item)} type="button">
              {item}
            </button>
          ))}
          {["1h", "6h", "24h"].map((item) => (
            <button className={range === item ? "primary-button" : "secondary-button"} key={item} onClick={() => setRange(item)} type="button">
              {item}
            </button>
          ))}
        </div>
      </section>
      {!runtime ? <LoadingState message="Loading runtime metrics..." /> : null}
      {runtime ? <ObservabilityStatusBanner runtime={runtime} /> : null}
      {runtime?.enabled === false ? <section className="panel"><p className="muted">{runtime.message}</p></section> : null}
      {runtime?.enabled !== false ? (
        <div className="dashboard-grid">
          <CpuMemoryChart runtime={runtime} />
          <AlbLatencyCard runtime={runtime} />
        </div>
      ) : null}
      </> : null}
    </div>
  );
}
