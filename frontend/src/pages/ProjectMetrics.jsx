import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getApplicationLogStreamUrl, getApplicationRuntimeMetrics, getProjectDetailedCurrentState } from "../api/projectApi.js";
import {
  Card,
  ChartCard,
  EmptyState,
  PageHeader,
  StatusChip,
} from "../components/common/DesignSystem.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { grafanaDashboardUrl } from "../utils/grafanaDashboardUrl.js";
import { projectStatePresentation } from "../utils/projectStatePresentation.js";
import { redirectDeletedProject, subscribeProjectStateChanged } from "../utils/projectStateSync.js";

const metricDefinitions = [
  { key: "cpu", title: "CPU utilization", unit: "%" },
  { key: "memory", title: "Memory utilization", unit: "%" },
  { key: "httpLatency", title: "Response time", unit: "s" },
  { key: "healthyHosts", title: "Healthy targets", unit: "" },
  { key: "unhealthyHosts", title: "Unhealthy targets", unit: "" },
  { key: "runtimeAvailability", title: "Runtime availability", unit: "" },
];

function label(value) {
  return value ? String(value).replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Unavailable";
}

function date(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Unavailable";
}

// CloudWatch returns averaged floats; present them at a precision an operator can read.
function formatMetric(value, unit = "") {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  if (unit === "%") return `${number.toFixed(1)}%`;
  if (unit === "s") return number < 1 ? `${Math.round(number * 1000)} ms` : `${number.toFixed(2)} s`;
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2)));
}

function runtimeLastScrape(runtime) {
  const values = metricDefinitions.flatMap(({ key }) => runtime?.[key]?.points || []).map((point) => Date.parse(point.timestamp)).filter(Number.isFinite);
  return values.length ? new Date(Math.max(...values)).toISOString() : null;
}

function MetricChart({ metric, metricKey, title, unit }) {
  const points = (metric?.points || []).slice(-40).filter((point) => Number.isFinite(Number(point.value)));
  const values = points.map((point) => Number(point.value));
  const minimum = Math.min(...values, 0);
  const maximum = Math.max(...values, 1);
  const span = Math.max(1, maximum - minimum);
  const coordinates = points.map((point, index) => `${48 + (index / Math.max(1, points.length - 1)) * 528},${16 + ((maximum - Number(point.value)) / span) * 136}`).join(" ");
  const latest = points.at(-1);
  return <ChartCard description={latest ? `Latest ${formatMetric(latest.value, unit)} · ${date(latest.timestamp)}` : undefined} hasData={points.length > 0} title={title}>
    <div className={`monitoring-line-chart metric-${metricKey}`}><svg aria-hidden="true" className="monitoring-sample-chart" preserveAspectRatio="none" viewBox="0 0 600 180"><text x="2" y="20">{formatMetric(maximum, unit)}</text><text x="2" y="156">{formatMetric(minimum, unit)}</text><line x1="48" x2="576" y1="16" y2="16" /><line x1="48" x2="576" y1="84" y2="84" /><line x1="48" x2="576" y1="152" y2="152" /><defs><linearGradient id={`monitoring-fill-${metricKey}`} x1="0" x2="0" y1="0" y2="1"><stop className="monitoring-fill-top" offset="0%" /><stop className="monitoring-fill-bottom" offset="100%" /></linearGradient></defs>{points.length ? <polygon className="monitoring-area" fill={`url(#monitoring-fill-${metricKey})`} points={`48,152 ${coordinates} ${48 + (points.length > 1 ? 528 : 0)},152`} /> : null}<polyline fill="none" points={coordinates} pathLength="1" vectorEffect="non-scaling-stroke" />{points.map((point, index) => { const [cx, cy] = coordinates.split(" ")[index].split(","); return <circle cx={cx} cy={cy} key={`${point.timestamp}-${index}`} r="3"><title>{date(point.timestamp)}: {formatMetric(point.value, unit)}</title></circle>; })}</svg><div className="monitoring-chart-axis"><span>{points[0] ? date(points[0].timestamp) : ""}</span><span>{latest ? date(latest.timestamp) : ""}</span></div><table className="sr-only"><caption>{title} timestamp and value series</caption><thead><tr><th>Timestamp</th><th>Value{unit ? ` (${unit})` : ""}</th></tr></thead><tbody>{points.map((point, index) => <tr key={`accessible-${point.timestamp}-${index}`}><td>{date(point.timestamp)}</td><td>{formatMetric(point.value, unit)}</td></tr>)}</tbody></table></div>
  </ChartCard>;
}

function latestMetric(runtime, key, unit = "") {
  const point = runtime?.[key]?.points?.at(-1);
  return point && Number.isFinite(Number(point.value)) ? formatMetric(point.value, unit) : null;
}

function mergeLogEvents(current, incoming) {
  const byId = new Map(current.map((entry) => [entry.id || `${entry.timestamp}:${entry.source}:${entry.message}`, entry]));
  for (const entry of incoming) byId.set(entry.id || `${entry.timestamp}:${entry.source}:${entry.message}`, entry);
  return [...byId.values()].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))).slice(-400);
}

function RuntimeLogViewer({ projectId, serviceId, live }) {
  const [connection, setConnection] = useState({ state: "connecting", message: "Connecting to live application logs…", generationId: null });
  const [events, setEvents] = useState([]);
  const [filter, setFilter] = useState("");
  const [reconnectKey, setReconnectKey] = useState(0);
  useEffect(() => {
    setEvents([]);
    setConnection({ state: "connecting", message: "Connecting to live application logs…", generationId: null });
    if (!live || !serviceId) return undefined;
    let active = true;
    const source = new EventSource(getApplicationLogStreamUrl(projectId, serviceId), { withCredentials: true });
    const receiveIdentity = (name) => (event) => {
      if (!active) return;
      const payload = JSON.parse(event.data);
      setEvents((current) => mergeLogEvents(name === "generation_changed" ? [] : current, payload.history || []));
      const next = { state: "connected", message: name === "generation_changed" ? "Switched to the current release." : "Streaming current application logs.", generationId: payload.generationId };
      setConnection(next);
    };
    const connected = receiveIdentity("connected");
    const generationChanged = receiveIdentity("generation_changed");
    const log = (event) => {
      if (!active) return;
      const payload = JSON.parse(event.data);
      setEvents((current) => mergeLogEvents(current, [payload]));
    };
    const warning = (event) => {
      if (!active) return;
      const payload = JSON.parse(event.data);
      setConnection((value) => ({ state: "reconnecting", message: payload.message || "Logs are temporarily unavailable; retrying.", generationId: value.generationId }));
    };
    source.addEventListener("connected", connected);
    source.addEventListener("generation_changed", generationChanged);
    source.addEventListener("log", log);
    source.addEventListener("warning", warning);
    source.onerror = () => {
      if (!active) return;
      setConnection((value) => ({ state: "reconnecting", message: "The log connection was interrupted. Reconnecting automatically…", generationId: value.generationId }));
    };
    return () => { active = false; source.close(); };
  }, [live, projectId, serviceId, reconnectKey]);
  const visibleEvents = filter.trim() ? events.filter((entry) => `${entry.source || ""} ${entry.message || ""}`.toLowerCase().includes(filter.trim().toLowerCase())) : events;
  return <Card className="monitoring-log-card">
    <div className="monitoring-section-heading"><div><h2>Application logs</h2><p>Recent events followed by live output.</p></div><div className="monitoring-log-actions"><StatusChip status={connection.state === "connected" ? "healthy" : connection.state}>{label(connection.state)}</StatusChip><button className="secondary-button" onClick={() => setReconnectKey((value) => value + 1)} type="button">Reconnect</button></div></div>
    <p className="monitoring-log-connection">{connection.message}</p>
    <label className="monitoring-log-search"><span className="sr-only">Filter logs</span><input autoComplete="off" name="logFilter" onChange={(event) => setFilter(event.target.value)} placeholder="Filter logs…" type="search" value={filter} /></label>
    <div aria-label="Live application logs" aria-live="polite" className="monitoring-log-viewer" role="log">
      {visibleEvents.length ? visibleEvents.map((entry, index) => <div className="monitoring-log-line" key={entry.id || `${entry.timestamp}-${index}`}><time>{new Date(entry.timestamp).toLocaleTimeString()}</time><span title={entry.source}>{entry.source || "ecs/app"}</span><code>{entry.message}</code></div>) : <p className="monitoring-log-empty">{events.length ? "No log entries match this filter." : "No application log events are available yet."}</p>}
    </div>
  </Card>;
}

export default function ProjectMetrics() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [range, setRange] = useState("1h");
  const [selectedServiceId, setSelectedServiceId] = useState("");
  const [runtime, setRuntime] = useState(null);
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const stateRequestId = useRef(0);
  const metricsRequestId = useRef(0);
  const liveInfrastructure = state?.stateAuthority?.runtime?.state === "present" && state?.stateAuthority?.infrastructure?.exists;
  const loadState = useCallback(async ({ showLoading = false } = {}) => {
    const requestId = ++stateRequestId.current;
    if (showLoading) setLoading(true);
    try {
      // Monitoring consumes the same bounded AWS observation as
      // Infrastructure; opening either page cannot change the authority.
      const current = await getProjectDetailedCurrentState(projectId);
      if (requestId !== stateRequestId.current) return;
      setState(current);
      const configuredServices = Array.isArray(current.infrastructureEvidence?.runtimeIdentity?.services) ? current.infrastructureEvidence.runtimeIdentity.services : [];
      setSelectedServiceId((currentServiceId) => configuredServices.some((service) => service.serviceId === currentServiceId) ? currentServiceId : configuredServices[0]?.serviceId || "");
      setError("");
    } catch (caught) {
      if (requestId === stateRequestId.current && !redirectDeletedProject(caught, navigate)) setError(caught.message);
    } finally {
      if (showLoading && requestId === stateRequestId.current) setLoading(false);
    }
  }, [navigate, projectId]);
  const loadMetrics = useCallback(async () => {
    const requestId = ++metricsRequestId.current;
    if (!liveInfrastructure || !selectedServiceId) { setRuntime(null); return; }
    try {
      const nextRuntime = await getApplicationRuntimeMetrics(projectId, { range, serviceId: selectedServiceId });
      if (requestId !== metricsRequestId.current) return;
      setRuntime(nextRuntime);
      setError("");
    } catch (caught) {
      if (requestId === metricsRequestId.current && !redirectDeletedProject(caught, navigate)) setError(caught.message);
    }
  }, [liveInfrastructure, navigate, projectId, range, selectedServiceId]);
  const refreshAll = useCallback(() => Promise.all([loadState(), loadMetrics()]), [loadMetrics, loadState]);
  useEffect(() => { void loadState({ showLoading: true }); }, [loadState]);
  useEffect(() => { setRuntime(null); void loadMetrics(); }, [loadMetrics]);
  useEffect(() => subscribeProjectStateChanged(projectId, () => { void refreshAll(); }), [projectId, refreshAll]);
  useEffect(() => {
    if (!liveInfrastructure) return undefined;
    const timer = window.setInterval(() => void refreshAll(), 30_000);
    return () => window.clearInterval(timer);
  }, [liveInfrastructure, refreshAll]);

  const presentation = projectStatePresentation(state);
  const authority = state?.stateAuthority;
  const evidence = state?.infrastructureEvidence;
  const services = Array.isArray(evidence?.runtimeIdentity?.services) ? evidence.runtimeIdentity.services : [];
  const selectedService = services.find((service) => service.serviceId === selectedServiceId) || services[0] || null;
  const runtimeCharts = metricDefinitions.filter(({ key }) => (runtime?.[key]?.points || []).length > 0);
  const lastScrape = runtimeLastScrape(runtime);

  if (loading) return <LoadingState message="Loading deployment health…" />;
  if (error && !state) return <ErrorState message={error} onRetry={() => loadState({ showLoading: true })} />;
  if (state && !liveInfrastructure) return <div className="monitoring-page page-stack dg-monitor" data-authoritative-state={presentation.state} data-monitoring-available="false"><PageHeader actions={<Link className="secondary-button" to={`/projects/${projectId}`}>Overview</Link>} description="Performance data appears after a runtime is deployed." eyebrow="Runtime" status={presentation.state} title="Monitoring" /><EmptyState icon="activity" message={authority?.monitoring?.reason || "The current runtime is not present."} title="Runtime monitoring unavailable" /></div>;

  const ecs = evidence?.ecs;
  const albHealth = evidence?.alb?.targetHealth || [];
  const metricsState = runtime?.availabilityState || (authority?.monitoring?.available ? "temporarily_unavailable" : "disabled_by_configuration");
  const runtimeAvailable = metricsState === "available";
  const grafanaConfigured = runtime?.grafana?.configured === true && Boolean(runtime?.grafana?.url);
  const grafanaUrl = grafanaConfigured
    ? grafanaDashboardUrl(runtime.grafana.url, projectId, selectedService?.ecs?.service || "")
    : "";
  const destroyOperation = authority?.activeOperation?.type === "destroy" ? "running" : authority?.latestCompletedOperation?.type === "destroy" && authority?.latestCompletedOperation?.outcome === "failed" ? "failed" : null;
  return <div className="monitoring-page page-stack dg-monitor" data-authoritative-state={presentation.state} data-monitoring-available={authority?.monitoring?.available ? "true" : "false"}>
    <PageHeader actions={<Link className="secondary-button" to={`/projects/${projectId}`}>Overview</Link>} context={[selectedService?.serviceName ? `Service ${selectedService.serviceName}` : null, state?.branch, state?.stableRelease?.commit ? `Release ${state.stableRelease.commit.slice(0, 12)}` : null].filter(Boolean).join(" · ")} description="Current performance and runtime health." title="Monitoring" />
    {error ? <ErrorState message={error} onRetry={refreshAll} /> : null}
    <div className="dg-mon-toolbar">
      {services.length > 1 ? <label className="monitoring-service-selector"><span>Service</span><select aria-label="Runtime service" name="runtimeService" onChange={(event) => setSelectedServiceId(event.target.value)} value={selectedService?.serviceId || ""}>{services.map((service) => <option key={service.serviceId} value={service.serviceId}>{service.serviceName}</option>)}</select></label> : null}
      <section aria-label="Metrics time range" className="monitoring-range-controls">{["1h", "6h", "24h"].map((item) => <button aria-pressed={range === item} className={range === item ? "button" : "secondary-button"} key={item} onClick={() => setRange(item)} type="button">{item}</button>)}</section>
      <span className="dg-mon-refresh">Auto-refreshes every 30 seconds</span>
    </div>
    {destroyOperation ? <Card><strong>{destroyOperation === "running" ? "Destroy is in progress." : "The latest Destroy failed."}</strong><p>The authoritative runtime is still present, so its ECS, ALB, logs, and metrics remain available.</p></Card> : null}
    <div className="dg-mon-board">
    <dl aria-label="Runtime performance summary" className="monitoring-summary-strip">
      {latestMetric(runtime, "cpu", "%") ? <div><dt>CPU</dt><dd>{latestMetric(runtime, "cpu", "%")}</dd></div> : null}
      {latestMetric(runtime, "memory", "%") ? <div><dt>Memory</dt><dd>{latestMetric(runtime, "memory", "%")}</dd></div> : null}
      {latestMetric(runtime, "httpLatency", "s") ? <div><dt>Response time</dt><dd>{latestMetric(runtime, "httpLatency", "s")}</dd></div> : null}
      {albHealth.length ? <div><dt>Health</dt><dd>{albHealth.every((item) => item === "healthy") ? "Available" : `${albHealth.filter((item) => item === "healthy").length}/${albHealth.length} healthy`}</dd></div> : null}
    </dl>
    <>
      {metricsState === "disabled_by_configuration" ? <EmptyState icon="activity" message={runtime?.message || "CloudWatch metrics are disabled by configuration."} title="Metrics disabled" /> : null}
      {metricsState === "temporarily_unavailable" ? <EmptyState icon="activity" message={runtime?.message || "CloudWatch metrics are temporarily unavailable."} title="Metrics temporarily unavailable" /> : null}
      {runtimeAvailable && runtimeCharts.length ? <section aria-label="Runtime metric charts" className="monitoring-chart-grid">{runtimeCharts.map(({ key, title, unit }) => <MetricChart key={key} metric={runtime[key]} metricKey={key} title={title} unit={unit} />)}</section> : null}
      {metricsState === "no_samples_yet" || (runtimeAvailable && !runtimeCharts.length) ? <EmptyState icon="activity" message="CloudWatch is available, but this range has no timestamped samples yet." title="No samples yet" /> : null}
    </>
    </div>
    <div className="dg-mon-bottom">
    <section className="monitoring-health-card"><details className="monitoring-health-details"><summary><span><strong>Monitoring details</strong></span><StatusChip status={evidence?.freshness}>{label(evidence?.freshness)}</StatusChip></summary>
      <div className="monitoring-health-grid">
        {runtime?.source ? <article><span>Telemetry source</span><strong>{runtime.source === "aws_cloudwatch" ? "Cloud monitoring" : label(runtime.source)}</strong></article> : null}
        {lastScrape ? <article><span>Last scrape</span><strong>{date(lastScrape)}</strong></article> : null}
        {evidence?.lastUpdatedAt ? <article><span>Observation time</span><strong>{date(evidence.lastUpdatedAt)}</strong></article> : null}
        {evidence?.freshness ? <article><span>Evidence freshness</span><strong>{label(evidence.freshness)}</strong></article> : null}
        {ecs ? <article><span>Service tasks</span><strong>{`${ecs.runningCount} running / ${ecs.desiredCount} desired${ecs.pendingCount ? ` / ${ecs.pendingCount} pending` : ""}`}</strong></article> : null}
        {grafanaConfigured ? <article><span>Dashboard</span><strong><a href={grafanaUrl} rel="noreferrer" target="_blank">Open Grafana</a></strong></article> : null}
      </div>
    </details></section>
    <RuntimeLogViewer key={selectedService?.serviceId || "default"} live={liveInfrastructure} projectId={projectId} serviceId={selectedService?.serviceId || ""} />
    </div>
  </div>;
}
