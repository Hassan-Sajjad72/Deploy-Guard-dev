import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getApplicationLogStreamUrl, getApplicationRuntimeMetrics, getProjectDetailedCurrentState } from "../api/projectApi.js";
import AppIcon from "../components/common/AppIcon.jsx";
import { Button, Callout, EmptyState, PageHeader, Status } from "../components/common/DesignSystem.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import Time from "../components/common/Time.jsx";
import { grafanaDashboardUrl } from "../utils/grafanaDashboardUrl.js";
import { projectStatePresentation } from "../utils/projectStatePresentation.js";
import { redirectDeletedProject, subscribeProjectStateChanged } from "../utils/projectStateSync.js";
import { formatDateTime, formatShortDateTime } from "../utils/time.js";

const metricDefinitions = [
  { key: "cpu", title: "CPU", unit: "%" },
  { key: "memory", title: "Memory", unit: "%" },
  { key: "httpLatency", title: "Response time", unit: "s" },
  { key: "healthyHosts", title: "Healthy instances", unit: "" },
  { key: "unhealthyHosts", title: "Unhealthy instances", unit: "" },
  { key: "runtimeAvailability", title: "Availability", unit: "" },
];
const CHARTED = new Set(["cpu", "memory", "httpLatency", "healthyHosts"]);

// CloudWatch returns averaged floats; present them at a precision an operator can read.
function formatMetric(value, unit = "") {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  if (unit === "%") return `${number.toFixed(1)}%`;
  if (unit === "s") return number < 1 ? `${Math.round(number * 1000)} ms` : `${number.toFixed(2)} s`;
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2)));
}

function runtimeLastScrape(runtime) {
  const values = metricDefinitions.flatMap(({ key }) => runtime?.[key]?.points || []).map((point) => Date.parse(point.timestamp)).filter(Number.isFinite);
  return values.length ? new Date(Math.max(...values)).toISOString() : null;
}

function MetricChart({ metric, metricKey, title, unit, note }) {
  const points = (metric?.points || []).slice(-60).filter((point) => Number.isFinite(Number(point.value)));
  const values = points.map((point) => Number(point.value));
  const minimum = Math.min(...values, 0);
  const maximum = Math.max(...values, unit === "%" ? 1 : 0.001) * (unit === "" ? 1 : 1.15);
  const span = Math.max(Number.EPSILON, maximum - minimum);
  const coordinates = points.map((point, index) => `${48 + (index / Math.max(1, points.length - 1)) * 548},${16 + ((maximum - Number(point.value)) / span) * 128}`).join(" ");
  const latest = points.at(-1);
  const lastPoint = coordinates.split(" ").at(-1)?.split(",");
  return <figure className="chart">
    <figcaption className="chart-head"><span>{title}</span><span><strong className="num">{latest ? formatMetric(latest.value, unit) : "—"}</strong>{note ? <small>{note}</small> : null}</span></figcaption>
    {points.length > 0 ? <div className={`chart-body metric-${metricKey}`}>
      <svg aria-hidden="true" className="chart-svg" preserveAspectRatio="none" viewBox="0 0 600 160"><text x="2" y="20">{formatMetric(maximum, unit)}</text><text x="2" y="148">{formatMetric(minimum, unit)}</text><line x1="48" x2="596" y1="16" y2="16" /><line x1="48" x2="596" y1="80" y2="80" /><line x1="48" x2="596" y1="144" y2="144" />{points.length > 1 ? <polygon className="chart-area" points={`48,144 ${coordinates} 596,144`} /> : null}<polyline fill="none" points={coordinates} vectorEffect="non-scaling-stroke" />{lastPoint ? <circle cx={lastPoint[0]} cy={lastPoint[1]} r="3" /> : null}</svg>
      <div className="chart-axis"><span>{formatShortDateTime(points[0]?.timestamp)}</span><span>{formatShortDateTime(latest?.timestamp)}</span></div>
      <table className="sr-only"><caption>{title} timestamp and value series</caption><thead><tr><th>Timestamp</th><th>Value{unit ? ` (${unit})` : ""}</th></tr></thead><tbody>{points.map((point, index) => <tr key={`accessible-${point.timestamp}-${index}`}><td>{formatDateTime(point.timestamp)}</td><td>{formatMetric(point.value, unit)}</td></tr>)}</tbody></table>
    </div> : <p className="chart-empty muted">No samples in this range.</p>}
  </figure>;
}

function latestMetric(runtime, key, unit = "") {
  const point = runtime?.[key]?.points?.at(-1);
  return point && Number.isFinite(Number(point.value)) ? formatMetric(point.value, unit) : "—";
}

function mergeLogEvents(current, incoming) {
  const byId = new Map(current.map((entry) => [entry.id || `${entry.timestamp}:${entry.source}:${entry.message}`, entry]));
  for (const entry of incoming) byId.set(entry.id || `${entry.timestamp}:${entry.source}:${entry.message}`, entry);
  return [...byId.values()].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))).slice(-400);
}

const CONNECTION_TEXT = { connecting: ["Connecting", "info"], connected: ["Streaming", "success"], reconnecting: ["Reconnecting", "warning"] };

function RuntimeLogViewer({ projectId, serviceId, live }) {
  const [connection, setConnection] = useState({ state: "connecting", message: "Connecting to the LIVE CloudWatch log group…", generationId: null });
  const [events, setEvents] = useState([]);
  const [filter, setFilter] = useState("");
  const [reconnectKey, setReconnectKey] = useState(0);
  const viewerRef = useRef(null);
  useEffect(() => {
    setEvents([]);
    setConnection({ state: "connecting", message: "Connecting to the LIVE CloudWatch log group…", generationId: null });
    if (!live || !serviceId) return undefined;
    let active = true;
    const source = new EventSource(getApplicationLogStreamUrl(projectId, serviceId), { withCredentials: true });
    const receiveIdentity = (name) => (event) => {
      if (!active) return;
      const payload = JSON.parse(event.data);
      setEvents((current) => mergeLogEvents(name === "generation_changed" ? [] : current, payload.history || []));
      setConnection({ state: "connected", message: name === "generation_changed" ? "Switched to the logs of the new live release." : "Showing recent output, then new lines as they arrive.", generationId: payload.generationId });
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
      setConnection((value) => ({ state: "reconnecting", message: payload.message || "CloudWatch is temporarily unavailable; retrying.", generationId: value.generationId }));
    };
    source.addEventListener("connected", connected);
    source.addEventListener("generation_changed", generationChanged);
    source.addEventListener("log", log);
    source.addEventListener("warning", warning);
    source.onerror = () => {
      if (!active) return;
      setConnection((value) => ({ state: "reconnecting", message: "The log connection dropped. Reconnecting automatically…", generationId: value.generationId }));
    };
    return () => { active = false; source.close(); };
  }, [live, projectId, serviceId, reconnectKey]);
  // Keep the newest line in view unless the reader has scrolled up.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (viewer && viewer.scrollHeight - viewer.scrollTop - viewer.clientHeight < 80) viewer.scrollTop = viewer.scrollHeight;
  }, [events]);
  const visibleEvents = filter.trim() ? events.filter((entry) => `${entry.source || ""} ${entry.message || ""}`.toLowerCase().includes(filter.trim().toLowerCase())) : events;
  const [connectionLabel, connectionTone] = CONNECTION_TEXT[connection.state] || ["Unknown", "neutral"];
  return <section aria-labelledby="logs-title" className="section">
    <div className="section-head"><h2 id="logs-title">Logs</h2><p>{connection.message}</p></div>
    <div className="logs">
      <div className="logs-bar">
        <Status active={connection.state !== "connected"} tone={connectionTone}>{connectionLabel}</Status>
        <label className="search logs-filter"><span className="sr-only">Filter logs</span><AppIcon name="search" size={15} /><input autoComplete="off" className="input" name="logFilter" onChange={(event) => setFilter(event.target.value)} placeholder="Filter lines" type="search" value={filter} /></label>
        <Button icon="refresh" onClick={() => setReconnectKey((value) => value + 1)} size="sm" tone="ghost">Reconnect</Button>
      </div>
      <div aria-label="Live application logs" aria-live="polite" className="logs-viewer" ref={viewerRef} role="log" tabIndex={0}>
        {visibleEvents.length ? visibleEvents.map((entry, index) => <div className="log-line" key={entry.id || `${entry.timestamp}-${index}`}><time>{new Date(entry.timestamp).toLocaleTimeString()}</time><span className="log-source" title={entry.source}>{entry.source || "app"}</span><code>{entry.message}</code></div>) : <p className="logs-empty">{events.length ? "No lines match this filter." : "No log output yet. New lines appear here as your app writes them."}</p>}
      </div>
    </div>
  </section>;
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

  if (loading) return <LoadingState message="Loading monitoring…" />;
  if (error && !state) return <div className="page"><ErrorState message={error} onRetry={() => loadState({ showLoading: true })} title="Monitoring could not be loaded" /></div>;
  if (state && !liveInfrastructure) return <div className="page monitoring-page" data-authoritative-state={presentation.state} data-monitoring-available="false"><PageHeader description="How your running app is performing." title="Monitoring" /><EmptyState action={<Button to={`/projects/${projectId}`}>Go to overview</Button>} icon="activity" message={authority?.monitoring?.reason || "Metrics and logs appear once your app is running."} title="Nothing is running" /></div>;

  const metricsState = runtime?.availabilityState || (authority?.monitoring?.available ? "temporarily_unavailable" : "disabled_by_configuration");
  const runtimeAvailable = metricsState === "available";
  const grafanaConfigured = runtime?.grafana?.configured === true && Boolean(runtime?.grafana?.url);
  const grafanaUrl = grafanaConfigured
    ? grafanaDashboardUrl(runtime.grafana.url, projectId, selectedService?.ecs?.service || "")
    : "";
  const destroyOperation = authority?.activeOperation?.type === "destroy" ? "running" : authority?.latestCompletedOperation?.type === "destroy" && authority?.latestCompletedOperation?.outcome === "failed" ? "failed" : null;
  const unhealthy = latestMetric(runtime, "unhealthyHosts");
  return <div className="page monitoring-page" data-authoritative-state={presentation.state} data-monitoring-available={authority?.monitoring?.available ? "true" : "false"}>
    <PageHeader
      actions={<>
        {services.length > 1 ? <label className="field monitoring-service"><span className="sr-only">Service</span><select aria-label="Runtime service" name="runtimeService" onChange={(event) => setSelectedServiceId(event.target.value)} value={selectedService?.serviceId || ""}>{services.map((service) => <option key={service.serviceId} value={service.serviceId}>{service.serviceName}</option>)}</select></label> : null}
        <div aria-label="Metrics time range" className="segmented" role="group">{["1h", "6h", "24h"].map((item) => <button aria-pressed={range === item} key={item} onClick={() => setRange(item)} type="button">{item}</button>)}</div>
        {grafanaConfigured ? <a className="btn btn-ghost" href={grafanaUrl} rel="noreferrer" target="_blank">Open Grafana<AppIcon className="external" name="external" size={14} /></a> : null}
      </>}
      description={<>How {services.length > 1 && selectedService ? <strong>{selectedService.serviceName}</strong> : "your app"} is performing. {lastScrape ? <>Last sample <Time value={lastScrape} />, refreshes every 30 seconds.</> : "Refreshes every 30 seconds."}</>}
      title="Monitoring"
    />
    {error ? <ErrorState message={error} onRetry={refreshAll} title="Showing the last loaded data" /> : null}
    {destroyOperation ? <Callout title={destroyOperation === "running" ? "Destroy in progress" : "The latest destroy failed"} tone="warning"><p>The app is still running, so its metrics and logs remain available.</p></Callout> : null}

    {metricsState === "disabled_by_configuration" ? <Callout title="Metrics are turned off" tone="neutral"><p>{runtime?.message || "CloudWatch metrics are disabled in this environment. Logs are still available below."}</p></Callout> : null}
    {metricsState === "temporarily_unavailable" ? <Callout title="Metrics are temporarily unavailable" tone="warning"><p>{runtime?.message || "CloudWatch did not respond. DeployGuard will try again on the next refresh."}</p></Callout> : null}
    {metricsState === "no_samples_yet" || (runtimeAvailable && !runtimeCharts.length) ? <Callout title="No samples yet" tone="neutral"><p>CloudWatch is connected but has no data points for this range yet.</p></Callout> : null}
    {runtimeAvailable && runtimeCharts.length ? <section aria-label="Metric history" className="charts">{runtimeCharts.filter(({ key }) => CHARTED.has(key)).map(({ key, title, unit }) => <MetricChart key={key} metric={runtime[key]} metricKey={key} note={key === "healthyHosts" ? (unhealthy !== "—" && unhealthy !== "0" ? `${unhealthy} unhealthy` : "all passing") : undefined} title={title} unit={unit} />)}</section> : null}

    <RuntimeLogViewer key={selectedService?.serviceId || "default"} live={liveInfrastructure} projectId={projectId} serviceId={selectedService?.serviceId || ""} />
  </div>;
}
