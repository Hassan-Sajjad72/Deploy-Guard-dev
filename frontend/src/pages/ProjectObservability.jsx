import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  getObservabilityHealth,
  getObservabilityRuntimeMetrics,
  getObservabilitySummary,
} from "../api/projectApi.js";
import { getProjectCurrentState } from "../api/projectApi.js";
import EmptyState from "../components/common/EmptyState.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import {
  BentoGrid,
  MetricCard,
  PageHeader,
  StatusBadge,
} from "../components/common/Premium.jsx";
import ObservabilityStatusBanner from "../components/observability/ObservabilityStatusBanner.jsx";
import ServiceHealthCard from "../components/observability/ServiceHealthCard.jsx";

export default function ProjectObservability() {
  const { projectId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;
    getProjectCurrentState(projectId)
      .then(async (currentState) => {
        if (!currentState.hasRealDeployment) return { currentState };
        const [summary, runtime, health] = await Promise.all([
          getObservabilitySummary(projectId),
          getObservabilityRuntimeMetrics(projectId, { source: "auto", range: "1h" }),
          getObservabilityHealth(projectId),
        ]);
        return { summary, runtime, health, currentState };
      })
      .then((response) => {
        if (mounted) setData(response);
      })
      .catch((err) => mounted && setError(err.message));
    return () => {
      mounted = false;
    };
  }, [projectId]);

  if (error) return <ErrorState message={error} />;
  if (!data) return <LoadingState message="Loading observability..." />;

  const summary = data.summary || {};
  const runtime = data.runtime || {};
  const health = data.health || {};
  const hasRuntime = Boolean(data.currentState?.hasRealDeployment);

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Runtime Signals"
        title="Observability"
        description="Live deployment health, runtime telemetry, logs, and operational signals."
        actions={hasRuntime ?
          <>
            <Link className="secondary-button" to={`/projects/${projectId}/observability/logs`}>Live Deployment Logs</Link>
            <Link className="secondary-button" to={`/projects/${projectId}/observability/metrics`}>Runtime Metrics</Link>
            <Link className="secondary-button" to={`/projects/${projectId}/orchestration/releases`}>Release History</Link>
          </> : null
        }
      />
      {!hasRuntime ? <EmptyState message="Runtime will be available after deployment." /> : null}
      {hasRuntime ? <>
      <ObservabilityStatusBanner summary={data.summary} runtime={data.runtime} />
      <BentoGrid>
        <MetricCard
          label="CloudWatch"
          value={data.currentState?.environmentModes?.cloudWatchLogsEnabled ? "Enabled" : "Disabled"}
          detail={hasRuntime ? summary.cloudWatchLogGroupName || "Waiting for deployment log-group metadata" : "Runtime log group is created with deployment"}
          tone={data.currentState?.environmentModes?.cloudWatchLogsEnabled ? "success" : "neutral"}
        />
        <MetricCard
          label="Prometheus"
          value={data.currentState?.environmentModes?.prometheusEnabled ? "Enabled" : "Disabled"}
          detail={hasRuntime && runtime.source ? `Source: ${runtime.source}` : "Runtime metrics begin after deployment"}
          tone={hasRuntime && runtime.source === "prometheus" ? "success" : "neutral"}
        />
        <section className="metric-card">
          <span className="metric-label">Health</span>
          <strong>{hasRuntime ? health.status || health.overallStatus || "Unknown" : "Available after deployment"}</strong>
          <p>
            <StatusBadge status={hasRuntime ? health.status || health.overallStatus || "unknown" : "unavailable"} />
          </p>
        </section>
      </BentoGrid>
      <div className="dashboard-grid">
        <ServiceHealthCard health={data.health} />
      </div>
      </> : null}
    </div>
  );
}
