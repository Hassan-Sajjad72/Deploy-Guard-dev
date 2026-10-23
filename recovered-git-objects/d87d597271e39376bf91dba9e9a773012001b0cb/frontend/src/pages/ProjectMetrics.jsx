import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getApplicationRuntimeMetrics, getProjectCurrentState } from "../api/projectApi.js";
import EmptyState from "../components/common/EmptyState.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { PageHeader } from "../components/common/Premium.jsx";
import AlbLatencyCard from "../components/observability/AlbLatencyCard.jsx";
import CpuMemoryChart from "../components/observability/CpuMemoryChart.jsx";
import { projectStatePresentation } from "../utils/projectStatePresentation.js";

export default function ProjectMetrics() {
  const { projectId } = useParams(); const [range, setRange] = useState("1h"); const [runtime, setRuntime] = useState(null); const [state, setState] = useState(null); const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  useEffect(() => { let active = true; setLoading(true); setRuntime(null); getProjectCurrentState(projectId).then(async (current) => { if (!active) return; setState(current); if (current.stateAuthority?.monitoring?.available && current.stableRelease) setRuntime(await getApplicationRuntimeMetrics(projectId, { range })); }).catch((caught) => active && setError(caught.message)).finally(() => active && setLoading(false)); return () => { active = false; }; }, [projectId, range]);
  const presentation = projectStatePresentation(state); const authority = state?.stateAuthority;
  return <div className="page-stack" data-authoritative-state={presentation.state} data-monitoring-available={authority?.monitoring?.available ? "true" : "false"}>
    <PageHeader eyebrow="Application" title="Monitoring" description="Fresh Prometheus/Grafana metrics when configured, with canonical ECS/ALB deployment-health evidence." actions={<Link className="secondary-button" to={`/projects/${projectId}`}>Overview</Link>} context={`Source: ${state?.infrastructureEvidence?.ecs ? "AWS ECS/ALB" : authority?.reconciliation?.source || "unavailable"} · Updated: ${state?.infrastructureEvidence?.lastUpdatedAt ? new Date(state.infrastructureEvidence.lastUpdatedAt).toLocaleString() : "Unavailable"} · ${state?.infrastructureEvidence?.freshness || "unavailable"}`} />
    {error ? <ErrorState message={error} /> : null}
    {loading ? <LoadingState message="Loading deployment health…" /> : null}
    {!loading && state ? <section className="panel-flat"><p className="eyebrow">Deployment health</p><h2>{authority?.applicationHealth?.status || "Unavailable"}</h2><dl><div><dt>Health source</dt><dd>{authority?.applicationHealth?.source || "unavailable"}</dd></div><div><dt>ECS / ALB infrastructure</dt><dd>{authority?.infrastructure?.status || "unknown"}</dd></div><div><dt>ECS tasks</dt><dd>{state.infrastructureEvidence?.ecs ? `${state.infrastructureEvidence.ecs.runningCount} running · ${state.infrastructureEvidence.ecs.desiredCount} desired · ${state.infrastructureEvidence.ecs.pendingCount} pending` : "Unavailable"}</dd></div><div><dt>ALB target health</dt><dd>{state.infrastructureEvidence?.alb?.targetHealth?.join(", ") || "Unavailable"}</dd></div><div><dt>Runtime metrics</dt><dd>{authority?.monitoring?.status || "unavailable"}</dd></div></dl></section> : null}
    {!loading && !authority?.monitoring?.available ? <EmptyState message={authority?.monitoring?.reason || "Monitoring evidence is unavailable."} /> : null}
    {authority?.monitoring?.available ? <section className="panel-flat"><div className="button-row" aria-label="Metrics time range">{["1h", "6h", "24h"].map((item) => <button className={range === item ? "primary-button" : "secondary-button"} key={item} onClick={() => setRange(item)} type="button">{item}</button>)}</div></section> : null}
    {runtime?.available === false ? <EmptyState message={runtime.message || "Fresh metrics are unavailable."} /> : null}
    {runtime?.available ? <div className="dashboard-grid"><CpuMemoryChart runtime={runtime} /><AlbLatencyCard runtime={runtime} /></div> : null}
  </div>;
}
