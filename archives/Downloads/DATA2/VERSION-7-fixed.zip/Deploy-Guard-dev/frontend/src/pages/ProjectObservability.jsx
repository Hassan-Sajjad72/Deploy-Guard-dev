import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  getObservabilityHealth,
  getObservabilityPipelineMetrics,
  getObservabilityRuntimeMetrics,
  getObservabilitySummary,
} from "../api/projectApi.js";
import { getProjectCurrentState } from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import {
  BentoGrid,
  MetricCard,
  PageHeader,
  ProjectQuickNav,
  StatusBadge,
} from "../components/common/Premium.jsx";
import GitHubActionsDurationCard from "../components/observability/GitHubActionsDurationCard.jsx";
import ObservabilityStatusBanner from "../components/observability/ObservabilityStatusBanner.jsx";
import PipelineMetricsTimeline from "../components/observability/PipelineMetricsTimeline.jsx";
import ServiceHealthCard from "../components/observability/ServiceHealthCard.jsx";
import StageDurationChart from "../components/observability/StageDurationChart.jsx";
import TrivyScanDurationCard from "../components/observability/TrivyScanDurationCard.jsx";
import ProjectModuleStatusStrip from "../components/projects/ProjectModuleStatusStrip.jsx";

export default function ProjectObservability() {
  const { projectId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;
    Promise.all([
      getObservabilitySummary(projectId),
      getObservabilityPipelineMetrics(projectId),
      getObservabilityRuntimeMetrics(projectId, { source: "auto", range: "1h" }),
      getObservabilityHealth(projectId),
      getProjectCurrentState(projectId),
    ])
      .then(([summary, pipeline, runtime, health, currentState]) => {
        if (mounted) setData({ summary, pipeline, runtime, health, currentState });
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
        description="Pipeline timings, runtime telemetry, live deployment logs, and health signals in one operational surface."
        actions={
          <>
            <Link className="secondary-button" to={`/projects/${projectId}/observability/logs`}>Live Deployment Logs</Link>
            <Link className="secondary-button" to={`/projects/${projectId}/observability/metrics`}>Runtime Metrics</Link>
          </>
        }
      />
      <ProjectQuickNav projectId={projectId} />
      <ProjectModuleStatusStrip moduleKey="observability" projectId={projectId} />

      <nav className="project-tabs" aria-label="Observability sections">
        <span className="active-tab">Overview</span>
        <Link to={`/projects/${projectId}/observability/metrics`}>Runtime Metrics</Link>
        <Link to={`/projects/${projectId}/observability/logs`}>Logs</Link>
        <Link to={`/projects/${projectId}/orchestration`}>Health</Link>
      </nav>

      <ObservabilityStatusBanner summary={data.summary} runtime={data.runtime} />
      {!hasRuntime ? <div className="state muted"><strong>Available after deployment:</strong> Runtime observability will be available after ECS deployment. Pipeline timings remain available below.</div> : null}
      <BentoGrid>
        <MetricCard
          label="Latest Pipeline"
          value={summary.latestPipelineDurationMs ? `${Math.round(summary.latestPipelineDurationMs / 1000)}s` : "-"}
          detail="End-to-end pipeline duration"
        />
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
        <GitHubActionsDurationCard workflow={data.pipeline.githubActions} />
        <TrivyScanDurationCard scan={data.pipeline.trivyScan} />
        {hasRuntime ? <ServiceHealthCard health={data.health} /> : null}
      </div>
      <StageDurationChart metrics={data.pipeline.stageMetrics || []} />
      <PipelineMetricsTimeline metrics={data.pipeline.stageMetrics || []} />
    </div>
  );
}
