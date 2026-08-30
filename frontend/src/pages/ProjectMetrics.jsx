import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getApplicationLogStreamUrl, getApplicationRuntimeMetrics, getProjectDetailedCurrentState } from "../api/projectApi.js";
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
  { key: "cpu", title: "ECS CPU utilization", unit: "%" },
  { key: "memory", title: "ECS memory utilization", unit: "%" },
  { key: "httpLatency", title: "ALB response latency", unit: "s" },
  { key: "healthyHosts", title: "Healthy targets", unit: "" },
  { key: "unhealthyHosts", title: "Unhealthy targets", unit: "" },
  { key: "runtimeAvailability", title: "Runtime availability", unit: "" },
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

function MetricChart({ metric, title, unit }) {
  const points = metric?.points || [];
  const max = Math.max(...points.map((point) => Math.abs(Number(point.value))), 1);
  return <ChartCard description="Timestamped samples from the configured runtime provider." hasData={points.length > 0} title={title}>
    <ol aria-label={`${title} samples`} className="monitoring-sample-chart">{points.slice(-40).map((point, index) => <li key={`${point.timestamp}-${index}`} title={`${date(point.timestamp)}: ${point.value}${unit}`}><i style={{ height: `${Math.max(5, (Math.abs(Number(point.value)) / max) * 100)}%` }} /></li>)}</ol>
  </ChartCard>;
}

function mergeLogEvents(current, incoming) {
  const byId = new Map(current.map((entry) => [entry.id || `${entry.timestamp}:${entry.source}:${entry.message}`, entry]));
  for (const entry of incoming) byId.set(entry.id || `${entry.timestamp}:${entry.source}:${entry.message}`, entry);
  return [...byId.values()].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))).slice(-400);
}

function RuntimeLogViewer({ projectId, serviceId, live, onConnectionChange }) {
  const [connection, setConnection] = useState({ state: "connecting", message: "Connecting to the LIVE CloudWatch log group…", generationId: null });
  const [events, setEvents] = useState([]);
  const [reconnectKey, setReconnectKey] = useState(0);
  useEffect(() => {
    if (!live) return undefined;
    setConnection((value) => ({ ...value, state: "connecting", message: "Connecting to the LIVE CloudWatch log group…" }));
    const source = new EventSource(getApplicationLogStreamUrl(projectId, serviceId), { withCredentials: true });
    const receiveIdentity = (name) => (event) => {
      const payload = JSON.parse(event.data);
      setEvents((current) => mergeLogEvents(name === "generation_changed" ? [] : current, payload.history || []));
      const next = { state: "connected", message: name === "generation_changed" ? "Switched to the new authoritative LIVE generation." : "Streaming the authoritative LIVE application logs.", generationId: payload.generationId };
      setConnection(next);
      onConnectionChange(next);
    };
    const connected = receiveIdentity("connected");
    const generationChanged = receiveIdentity("generation_changed");
    const log = (event) => {
      const payload = JSON.parse(event.data);
      setEvents((current) => mergeLogEvents(current, [payload]));
    };
    const warning = (event) => {
      const payload = JSON.parse(event.data);
      const next = { state: "reconnecting", message: payload.message || "CloudWatch is temporarily unavailable; retrying.", generationId: connection.generationId };
      setConnection(next);
      onConnectionChange(next);
    };
    source.addEventListener("connected", connected);
    source.addEventListener("generation_changed", generationChanged);
    source.addEventListener("log", log);
    source.addEventListener("warning", warning);
    source.onerror = () => {
      const next = { state: "reconnecting", message: "The log connection was interrupted. Reconnecting automatically…", generationId: connection.generationId };
      setConnection(next);
      onConnectionChange(next);
    };
    return () => source.close();
  }, [live, projectId, serviceId, reconnectKey]);
  return <Card className="monitoring-log-card">
    <div className="monitoring-section-heading"><div><p className="eyebrow">Live runtime output</p><h2>ECS application logs</h2><p>Bounded recent history followed by new CloudWatch events from the authoritative LIVE generation.</p></div><div className="monitoring-log-actions"><StatusChip status={connection.state === "connected" ? "healthy" : connection.state}>{label(connection.state)}</StatusChip><button className="secondary-button" onClick={() => setReconnectKey((value) => value + 1)} type="button">Reconnect</button></div></div>
    <p className="monitoring-log-connection">{connection.message}</p>
    <div aria-label="Live ECS application logs" aria-live="polite" className="monitoring-log-viewer" role="log">
      {events.length ? events.map((entry, index) => <div className="monitoring-log-line" key={entry.id || `${entry.timestamp}-${index}`}><time>{new Date(entry.timestamp).toLocaleTimeString()}</time><span title={entry.source}>{entry.source || "ecs/app"}</span><code>{entry.message}</code></div>) : <p className="monitoring-log-empty">No application log events are available in the bounded history window yet.</p>}
    </div>
  </Card>;
}

export default function ProjectMetrics() {
  const { projectId } = useParams();
  const [range, setRange] = useState("1h");
  const [selectedServiceId, setSelectedServiceId] = useState("");
  const [runtime, setRuntime] = useState(null);
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [logs, setLogs] = useState({ state: "connecting", message: "Connecting to CloudWatch logs…" });
  const updateLogConnection = useCallback((next) => setLogs(next), []);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Monitoring consumes the same bounded AWS observation as
      // Infrastructure; opening either page cannot change the authority.
      const current = await getProjectDetailedCurrentState(projectId);
      setState(current);
      const configuredServices = Array.isArray(current.infrastructureEvidence?.runtimeIdentity?.services) ? current.infrastructureEvidence.runtimeIdentity.services : [];
      const effectiveServiceId = configuredServices.some((service) => service.serviceId === selectedServiceId)
        ? selectedServiceId
        : configuredServices[0]?.serviceId || "";
      if (effectiveServiceId !== selectedServiceId) setSelectedServiceId(effectiveServiceId);
      setRuntime(null);
      if (current.stateAuthority?.runtime?.state === "present" && current.stateAuthority?.infrastructure?.exists) {
        setRuntime(await getApplicationRuntimeMetrics(projectId, { range, serviceId: effectiveServiceId }));
      }
      setError("");
    } catch (caught) { setError(caught.message); } finally { setLoading(false); }
  }, [projectId, range, selectedServiceId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => subscribeProjectStateChanged(projectId, load), [load, projectId]);
  useEffect(() => {
    if (state?.stateAuthority?.runtime?.state !== "present" || !state?.stateAuthority?.infrastructure?.exists) return undefined;
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load, state?.stateAuthority?.runtime?.state, state?.stateAuthority?.infrastructure?.exists]);

  const presentation = projectStatePresentation(state);
  const authority = state?.stateAuthority;
  const evidence = state?.infrastructureEvidence;
  const services = Array.isArray(evidence?.runtimeIdentity?.services) ? evidence.runtimeIdentity.services : [];
  const selectedService = services.find((service) => service.serviceId === selectedServiceId) || services[0] || null;
  const liveInfrastructure = authority?.runtime?.state === "present" && authority?.infrastructure?.exists;
  const runtimeCharts = metricDefinitions.filter(({ key }) => (runtime?.[key]?.points || []).length > 0);
  const lastScrape = runtimeLastScrape(runtime);

  if (loading) return <LoadingState message="Loading deployment health…" />;
  if (error && !state) return <ErrorState message={error} onRetry={load} />;
  if (state && !liveInfrastructure) return <div className="monitoring-page page-stack" data-authoritative-state={presentation.state} data-monitoring-available="false"><PageHeader actions={<Link className="secondary-button" to={`/projects/${projectId}`}>Overview</Link>} description="Runtime monitoring follows the same authoritative AWS observation as Infrastructure." eyebrow="Application health" status={presentation.state} title="Monitoring" /><section aria-label="Deployment health summary" className="monitoring-summary-grid"><MetricCard label="Application" value={label(authority?.runtime?.state)} /><MetricCard label="ECS" value={label(evidence?.resources?.find((resource) => resource.type === "ECS Fargate")?.status)} /><MetricCard label="Load Balancer" value={label(evidence?.resources?.find((resource) => resource.type === "ALB")?.status)} /><MetricCard label="Logs" value="Unavailable" /><MetricCard label="Metrics" value="Unavailable" /><MetricCard label="Grafana" value="Not applicable" /></section><EmptyState icon="activity" message={authority?.monitoring?.reason || "The authoritative runtime is not currently present."} title="Runtime monitoring unavailable" /></div>;

  const ecs = evidence?.ecs;
  const albHealth = evidence?.alb?.targetHealth || [];
  const metricsState = runtime?.availabilityState || (authority?.monitoring?.available ? "temporarily_unavailable" : "disabled_by_configuration");
  const runtimeAvailable = metricsState === "available";
  const metricsLabel = {
    available: "Available",
    disabled_by_configuration: "Disabled by configuration",
    temporarily_unavailable: "Temporarily unavailable",
    no_samples_yet: "No samples yet",
  }[metricsState] || "Temporarily unavailable";
  const grafanaConfigured = runtime?.grafana?.configured === true && Boolean(runtime?.grafana?.url);
  const destroyOperation = authority?.activeOperation?.type === "destroy" ? "running" : authority?.latestCompletedOperation?.type === "destroy" && authority?.latestCompletedOperation?.outcome === "failed" ? "failed" : null;
  return <div className="monitoring-page page-stack" data-authoritative-state={presentation.state} data-monitoring-available={authority?.monitoring?.available ? "true" : "false"}>
    <PageHeader actions={<Link className="secondary-button" to={`/projects/${projectId}`}>Overview</Link>} context={`Source: GitHub Actions and AWS · Last updated: ${date(evidence?.lastUpdatedAt)} · ${label(evidence?.freshness)}`} description="Deployed application and infrastructure health only. GitHub Actions execution timing remains on Pipeline." eyebrow="Application health" status={presentation.state} title="Monitoring" />
    {error ? <ErrorState message={error} onRetry={load} /> : null}
    {destroyOperation ? <Card><strong>{destroyOperation === "running" ? "Destroy is in progress." : "The latest Destroy failed."}</strong><p>The authoritative runtime is still present, so its ECS, ALB, logs, and metrics remain available.</p></Card> : null}
    {services.length > 1 ? <Card><label className="field"><span>Runtime service</span><select aria-label="Runtime service" onChange={(event) => setSelectedServiceId(event.target.value)} value={selectedService?.serviceId || ""}>{services.map((service) => <option key={service.serviceId} value={service.serviceId}>{service.serviceName}</option>)}</select></label><p>Metrics and live logs are bound to the selected service in the authoritative LIVE generation.</p></Card> : null}
    <section aria-label="Deployment health summary" className="monitoring-summary-grid">
      <MetricCard detail={`Source: ${evidenceSourceLabel(authority?.applicationHealth?.source)}`} label="Application" tone={authority?.applicationHealth?.status === "healthy" ? "success" : "warning"} value={label(authority?.applicationHealth?.status)} />
      <MetricCard detail={ecs ? `${ecs.desiredCount} desired · ${ecs.pendingCount} pending` : "No current AWS observation"} label="ECS" tone={ecs?.runningCount === ecs?.desiredCount ? "success" : "neutral"} value={ecs ? `${ecs.runningCount}/${ecs.desiredCount}` : "Unavailable"} />
      <MetricCard detail={albHealth.length ? "Same bounded AWS observation as Infrastructure" : "No current AWS observation"} label="Load Balancer" tone={albHealth.includes("healthy") ? "success" : "neutral"} value={albHealth.length ? albHealth.map(label).join(", ") : "Unavailable"} />
      <MetricCard detail={logs.message} label="Logs" tone={logs.state === "connected" ? "success" : "neutral"} value={label(logs.state)} />
      <MetricCard detail={runtime?.message || "CloudWatch provider state"} label="Metrics" tone={runtimeAvailable ? "success" : "neutral"} value={metricsLabel} />
      <MetricCard detail={grafanaConfigured ? "Configured independently from CloudWatch metrics" : "No GRAFANA_BASE_URL is configured"} label="Grafana" tone={grafanaConfigured ? "success" : "neutral"} value={grafanaConfigured ? <a href={runtime.grafana.url} rel="noreferrer" target="_blank">Open Grafana</a> : "Not configured"} />
    </section>
    <Card className="monitoring-health-card"><div className="monitoring-section-heading"><div><p className="eyebrow">Health details</p><h2>Current deployment evidence</h2><p>Runtime provider data is separate from GitHub Actions and AWS deployment-health verification.</p></div><StatusChip status={evidence?.freshness}>{label(evidence?.freshness)}</StatusChip></div>
      <div className="monitoring-health-grid">
        <article><span>Runtime telemetry</span><strong>{runtime?.source === "aws_cloudwatch" ? "AWS CloudWatch" : "Unavailable"}</strong></article>
        <article><span>Last scrape</span><strong>{date(lastScrape)}</strong></article>
        <article><span>AWS observation</span><strong>{date(evidence?.lastUpdatedAt)}</strong></article>
        <article><span>Evidence freshness</span><strong>{label(evidence?.freshness)}</strong></article>
        <article><span>ALB health</span><strong>{albHealth.length ? albHealth.map(label).join(", ") : "Unavailable"}</strong></article>
        <article><span>ECS task health</span><strong>{ecs ? `${ecs.runningCount} running / ${ecs.desiredCount} desired / ${ecs.pendingCount} pending` : "Unavailable"}</strong></article>
        <article><span>Grafana</span><strong>{grafanaConfigured ? <a href={runtime.grafana.url} rel="noreferrer" target="_blank">Open Grafana</a> : "Not configured"}</strong></article>
      </div>
    </Card>
    <>
      <section aria-label="Metrics time range" className="monitoring-range-controls">{["1h", "6h", "24h"].map((item) => <button aria-pressed={range === item} className={range === item ? "button" : "secondary-button"} key={item} onClick={() => setRange(item)} type="button">{item}</button>)}</section>
      {metricsState === "disabled_by_configuration" ? <EmptyState icon="activity" message={runtime?.message || "CloudWatch metrics are disabled by configuration."} title="Metrics disabled" /> : null}
      {metricsState === "temporarily_unavailable" ? <EmptyState icon="activity" message={runtime?.message || "CloudWatch metrics are temporarily unavailable."} title="Metrics temporarily unavailable" /> : null}
      {runtimeAvailable && runtimeCharts.length ? <section aria-label="Runtime metric charts" className="monitoring-chart-grid">{runtimeCharts.map(({ key, title, unit }) => <MetricChart key={key} metric={runtime[key]} title={title} unit={unit} />)}</section> : null}
      {metricsState === "no_samples_yet" || (runtimeAvailable && !runtimeCharts.length) ? <EmptyState icon="activity" message="CloudWatch is available, but this range has no timestamped samples yet." title="No samples yet" /> : null}
    </>
    <RuntimeLogViewer live={liveInfrastructure} onConnectionChange={updateLogConnection} projectId={projectId} serviceId={selectedService?.serviceId || ""} />
  </div>;
}
