import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { getApplicationRuntimeMetrics, getProjectCurrentState } from "../api/projectApi.js";
import {
  Card,
  ChartCard,
  EmptyState,
  MetricCard,
  PageHeader,
  StatusChip,
} from "../components/common/DesignSystem.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { projectStatePresentation } from "../utils/projectStatePresentation.js";
import { subscribeProjectStateChanged } from "../utils/projectStateSync.js";

const metricDefinitions = [
  { key: "requestRate", title: "Request rate" },
  { key: "httpLatency", title: "HTTP latency" },
  { key: "cpu", title: "CPU utilization" },
  { key: "memory", title: "Memory utilization" },
];

function label(value) {
  return value ? String(value).replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Unavailable";
}

function evidenceSourceLabel(value) {
  if (value === "github_actions_health_verification") return "GitHub Actions health verification";
  if (value === "github_actions") return "GitHub Actions";
  return label(value);
}

function date(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Unavailable";
}

function runtimeLastScrape(runtime) {
  const values = metricDefinitions.flatMap(({ key }) => runtime?.[key]?.points || []).map((point) => Date.parse(point.timestamp)).filter(Number.isFinite);
  return values.length ? new Date(Math.max(...values)).toISOString() : null;
}

function MetricChart({ metric, title }) {
  const points = metric?.points || [];
  const max = Math.max(...points.map((point) => Math.abs(Number(point.value))), 1);
  return <ChartCard description="Timestamped samples from the configured runtime provider." hasData={points.length > 0} title={title}>
    <ol aria-label={`${title} samples`} className="monitoring-sample-chart">{points.slice(-40).map((point, index) => <li key={`${point.timestamp}-${index}`} title={`${date(point.timestamp)}: ${point.value}`}><i style={{ height: `${Math.max(5, (Math.abs(Number(point.value)) / max) * 100)}%` }} /></li>)}</ol>
  </ChartCard>;
}

export default function ProjectMetrics() {
  const { projectId } = useParams();
  const [range, setRange] = useState("1h");
  const [runtime, setRuntime] = useState(null);
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const current = await getProjectCurrentState(projectId);
      setState(current);
      setRuntime(null);
      if (current.stateAuthority?.state === "LIVE" && current.stateAuthority?.infrastructure?.exists && current.stateAuthority?.monitoring?.available) {
        setRuntime(await getApplicationRuntimeMetrics(projectId, { range }));
      }
      setError("");
    } catch (caught) { setError(caught.message); } finally { setLoading(false); }
  }, [projectId, range]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => subscribeProjectStateChanged(projectId, load), [load, projectId]);
  useEffect(() => {
    if (state?.stateAuthority?.state !== "LIVE" || !state?.stateAuthority?.infrastructure?.exists) return undefined;
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load, state?.stateAuthority?.state, state?.stateAuthority?.infrastructure?.exists]);

  const presentation = projectStatePresentation(state);
  const authority = state?.stateAuthority;
  const evidence = state?.infrastructureEvidence;
  const liveInfrastructure = authority?.state === "LIVE" && authority?.infrastructure?.exists;
  const runtimeCharts = metricDefinitions.filter(({ key }) => (runtime?.[key]?.points || []).length > 0).slice(0, 4);
  const lastScrape = runtimeLastScrape(runtime);

  if (loading) return <LoadingState message="Loading deployment health…" />;
  if (error && !state) return <ErrorState message={error} onRetry={load} />;
  if (state && !liveInfrastructure) return <Navigate replace to={`/projects/${projectId}`} />;

  const ecs = evidence?.ecs;
  const albHealth = evidence?.alb?.targetHealth || [];
  return <div className="monitoring-page page-stack" data-authoritative-state={presentation.state} data-monitoring-available={authority?.monitoring?.available ? "true" : "false"}>
    <PageHeader actions={<Link className="secondary-button" to={`/projects/${projectId}`}>Overview</Link>} context={`Source: GitHub Actions and AWS · Last updated: ${date(evidence?.lastUpdatedAt)} · ${label(evidence?.freshness)}`} description="Deployed application and infrastructure health only. GitHub Actions execution timing remains on Pipeline." eyebrow="Application health" status={presentation.state} title="Monitoring" />
    {error ? <ErrorState message={error} onRetry={load} /> : null}
    <section aria-label="Deployment health summary" className="monitoring-summary-grid">
      <MetricCard detail={`Source: ${evidenceSourceLabel(authority?.applicationHealth?.source)}`} label="Application status" tone={authority?.applicationHealth?.status === "healthy" ? "success" : "warning"} value={label(authority?.applicationHealth?.status)} />
      <MetricCard detail={authority?.monitoring?.available ? "Provider samples are available below." : "No uptime signal has been reported by a runtime provider."} label="Runtime metrics" tone={authority?.monitoring?.available ? "success" : "neutral"} value={authority?.monitoring?.available ? "Available" : "Not configured"} />
      <MetricCard detail={ecs ? `${ecs.desiredCount} desired · ${ecs.pendingCount} pending` : "No current ECS task evidence"} label="Running ECS tasks" tone={ecs?.runningCount ? "success" : "neutral"} value={ecs ? `${ecs.runningCount}/${ecs.desiredCount}` : "Unavailable"} />
      <MetricCard detail={albHealth.length ? "Live AWS target-health evidence" : "No current load-balancer evidence"} label="ALB target health" tone={albHealth.includes("healthy") ? "success" : "neutral"} value={albHealth.length ? albHealth.map(label).join(", ") : "Unavailable"} />
    </section>
    <Card className="monitoring-health-card"><div className="monitoring-section-heading"><div><p className="eyebrow">Health details</p><h2>Current deployment evidence</h2><p>Runtime provider data is separate from GitHub Actions and AWS deployment-health verification.</p></div><StatusChip status={evidence?.freshness}>{label(evidence?.freshness)}</StatusChip></div>
      <div className="monitoring-health-grid">
        <article><span>Data source</span><strong>{evidenceSourceLabel(authority?.applicationHealth?.source)}</strong></article>
        <article><span>Last scrape</span><strong>{date(lastScrape)}</strong></article>
        <article><span>AWS observation</span><strong>{date(evidence?.lastUpdatedAt)}</strong></article>
        <article><span>Evidence freshness</span><strong>{label(evidence?.freshness)}</strong></article>
        <article><span>ALB health</span><strong>{albHealth.length ? albHealth.map(label).join(", ") : "Unavailable"}</strong></article>
        <article><span>ECS task health</span><strong>{ecs ? `${ecs.runningCount} running / ${ecs.desiredCount} desired / ${ecs.pendingCount} pending` : "Unavailable"}</strong></article>
        <article><span>Grafana</span><strong>{runtime?.grafanaUrl ? <a href={runtime.grafanaUrl} rel="noreferrer" target="_blank">Open Grafana</a> : "Not configured"}</strong></article>
      </div>
    </Card>
    {!authority?.monitoring?.available ? <EmptyState icon="activity" message="Deployment health is still verified through ECS and ALB. Configure Prometheus and Grafana to view CPU, memory, request, error and latency trends." title="Runtime metrics are not configured" /> : null}
    {authority?.monitoring?.available ? <>
      <section aria-label="Metrics time range" className="monitoring-range-controls">{["1h", "6h", "24h"].map((item) => <button aria-pressed={range === item} className={range === item ? "button" : "secondary-button"} key={item} onClick={() => setRange(item)} type="button">{item}</button>)}</section>
      {runtime?.available === false ? <EmptyState icon="activity" message={runtime.message || "Fresh metrics are unavailable."} title="Runtime metrics unavailable" /> : null}
      {runtime?.available && runtimeCharts.length ? <section aria-label="Runtime metric charts" className="monitoring-chart-grid">{runtimeCharts.map(({ key, title }) => <MetricChart key={key} metric={runtime[key]} title={title} />)}</section> : null}
      {runtime?.available && !runtimeCharts.length ? <EmptyState icon="activity" message="The configured runtime provider returned no timestamped samples for this range." title="No runtime samples yet" /> : null}
    </> : null}
  </div>;
}
