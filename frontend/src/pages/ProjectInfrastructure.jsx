import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getProjectDetailedCurrentState } from "../api/projectApi.js";
import { Card, ChartCard, CopyValue, DataTable, EmptyState, MetricCard, PageHeader, StatusChip } from "../components/common/DesignSystem.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { subscribeProjectStateChanged } from "../utils/projectStateSync.js";
import { projectStatePresentation } from "../utils/projectStatePresentation.js";

function label(value) {
  return value ? String(value).replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Unavailable";
}

function date(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Unavailable";
}

function shortened(value, max = 34) {
  if (!value) return "Unavailable";
  const text = String(value);
  return text.length > max ? `${text.slice(0, max - 10)}…${text.slice(-8)}` : text;
}

function healthStatus(value, available) {
  return available ? "active" : value === "destroyed" ? "historical" : "unavailable";
}

function ServiceFlow({ state, evidence }) {
  const live = state?.stateAuthority?.state === "LIVE";
  const ecsHealthy = Boolean(evidence?.ecs && evidence.ecs.runningCount >= evidence.ecs.desiredCount && evidence.ecs.pendingCount === 0);
  const albHealthy = evidence?.alb?.targetHealth?.length > 0 && evidence.alb.targetHealth.every((item) => item === "healthy");
  const nodes = [
    { name: "Source", detail: shortened(state?.stableRelease?.commit, 18), available: Boolean(state?.stableRelease?.commit) },
    { name: "Railpack", detail: live ? "Image built" : "Unavailable", available: live },
    { name: "ECR", detail: evidence?.ecr?.imageDigest ? "Immutable digest" : "Unavailable", available: Boolean(evidence?.ecr?.imageDigest) },
    { name: "ECS", detail: evidence?.ecs ? `${evidence.ecs.runningCount}/${evidence.ecs.desiredCount} running` : "Unavailable", available: ecsHealthy },
    { name: "ALB", detail: albHealthy ? "Targets healthy" : "Unavailable", available: albHealthy },
    { name: "Application", detail: live ? "LIVE" : "Unavailable", available: live && Boolean(evidence?.alb?.endpoint || state?.stableUrl) },
  ];
  return <Card className="infrastructure-topology-card">
    <div className="infrastructure-section-heading"><div><p className="eyebrow">Current AWS observation</p><h2>Service flow · Source to application</h2><p>Every status is projected from the authoritative LIVE generation and its bounded AWS observation.</p></div><span className="infrastructure-source">Generation {shortened(state?.generationState?.liveGenerationId, 20)}</span></div>
    <ol aria-label="Infrastructure service flow" className="infrastructure-topology">{nodes.map((node) => <li data-status={healthStatus(evidence?.terraformState?.status, node.available)} key={node.name}><strong>{node.name}</strong><span>{node.detail}</span><StatusChip status={node.available ? "healthy" : "unavailable"}>{node.available ? "Healthy" : "Unavailable"}</StatusChip></li>)}</ol>
    {evidence?.alb?.endpoint ? <p className="infrastructure-endpoint">Application endpoint: <a href={evidence.alb.endpoint} rel="noreferrer" target="_blank">Open verified application</a></p> : null}
  </Card>;
}

function SupportingServices({ evidence }) {
  const cost = evidence?.cost;
  const terraformAvailable = evidence?.terraformState?.status === "active";
  const cloudWatchAvailable = evidence?.cloudWatch?.status === "active";
  const infracostAvailable = cost?.source === "infracost" && ["estimated", "approval_required"].includes(cost?.status);
  const services = [
    ["Terraform", terraformAvailable ? "State active" : label(evidence?.terraformState?.status), terraformAvailable],
    ["CloudWatch", cloudWatchAvailable ? "Log group observed" : label(evidence?.cloudWatch?.status), cloudWatchAvailable],
    ["Infracost", infracostAvailable ? `${cost.currency || "USD"} ${Number(cost.monthly || 0).toFixed(2)}/month` : cost?.unavailableReason || "Unavailable", infracostAvailable],
  ];
  return <Card><div className="infrastructure-section-heading"><div><p className="eyebrow">Supporting services</p><h2>Runtime operations</h2></div></div><div className="infrastructure-support-grid">{services.map(([name, detail, available]) => <article key={name}><span>{name}</span><strong>{available ? "Available" : "Unavailable"}</strong><p>{detail}</p></article>)}</div></Card>;
}

function Pricing({ cost }) {
  const available = cost?.source === "infracost" && ["estimated", "approval_required"].includes(cost?.status) && Number.isFinite(cost?.monthly);
  const breakdown = Array.isArray(cost?.breakdown) ? cost.breakdown.filter((item) => Number.isFinite(item?.monthly)) : [];
  const maximum = Math.max(...breakdown.map((item) => Number(item.monthly)), 1);
  return <Card className="infrastructure-finops-card"><div className="infrastructure-section-heading"><div><p className="eyebrow">Infracost</p><h2>Persisted LIVE release pricing</h2><p>DeployGuard displays persisted Infracost evidence only; the browser never calculates infrastructure cost.</p></div><span className="infrastructure-source">Source: {available ? "Infracost" : "Unavailable"}</span></div>
    {available ? <><div className="infrastructure-cost-summary"><MetricCard detail={`Estimated ${date(cost.estimatedAt)}`} label="Monthly estimate" value={`${cost.currency || "USD"} ${Number(cost.monthly).toFixed(2)}`} /><MetricCard detail={label(cost.status)} label="Pricing status" value="Persisted evidence" /></div><ChartCard description="Monthly service estimates persisted with this release." hasData={breakdown.length > 0} emptyMessage="No service-level breakdown was returned." title="Service breakdown"><ol className="infrastructure-cost-bars">{breakdown.map((item) => <li key={`${item.name}-${item.monthly}`}><span>{item.service || item.name}</span><strong>{cost.currency || "USD"} {Number(item.monthly).toFixed(2)}</strong><i style={{ width: `${Math.max(2, (Number(item.monthly) / maximum) * 100)}%` }} /></li>)}</ol></ChartCard></> : <EmptyState icon="activity" message={cost?.unavailableReason || "The current LIVE release has no persisted Infracost evidence."} title="Pricing unavailable" />}
  </Card>;
}

function TechnicalDetails({ state, evidence }) {
  const identity = evidence?.runtimeIdentity || {};
  const rows = [
    ["Generation", state?.generationState?.liveGenerationId], ["Source SHA", state?.stableRelease?.commit],
    ["Image", identity.imageDigest ? `${identity.imageUri}@${identity.imageDigest}` : identity.imageUri],
    ["ECS cluster", identity.ecsClusterArn || identity.ecsClusterName], ["ECS service", identity.ecsServiceArn || identity.ecsServiceName],
    ["Task definition", identity.taskDefinitionArn], ["ALB", identity.albArn || identity.albName],
    ["Target group", identity.targetGroupArn || identity.targetGroupName], ["CloudWatch log group", identity.cloudWatchLogGroupName],
    ["Terraform state", identity.terraformStateKey || evidence?.terraformState?.key],
  ];
  return <Card className="infrastructure-inventory-card"><div className="infrastructure-section-heading"><div><p className="eyebrow">Technical details</p><h2>Persisted verified identity</h2><p>Full immutable identifiers remain available here without dominating the service-health view.</p></div></div><DataTable caption="Authoritative LIVE resource identifiers" label="Technical infrastructure details"><thead><tr><th>Resource</th><th>Identifier</th></tr></thead><tbody>{rows.map(([name, value]) => <tr key={name}><td>{name}</td><td>{value ? <CopyValue label="Copy full identifier" value={String(value)} visibleValue={shortened(value, 58)} /> : "Unavailable"}</td></tr>)}</tbody></DataTable></Card>;
}

export default function ProjectInfrastructure() {
  const { projectId } = useParams();
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => { try { setError(""); setState(await getProjectDetailedCurrentState(projectId)); } catch (caught) { setError(caught.message); } }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => subscribeProjectStateChanged(projectId, load), [load, projectId]);
  useEffect(() => { if (!projectStatePresentation(state).active) return undefined; const timer = window.setInterval(load, 5000); return () => window.clearInterval(timer); }, [state?.stateAuthority?.activeOperation?.id, state?.stateAuthority?.activeOperation?.status, load]);
  if (!state && !error) return <LoadingState message="Loading infrastructure state…" />;
  const infrastructure = state?.stateAuthority?.infrastructure;
  const evidence = state?.infrastructureEvidence;
  const failedDestroy = state?.stateAuthority?.latestCompletedOperation?.type === "destroy"
    && state?.stateAuthority?.latestCompletedOperation?.outcome === "failed";
  const cleanupRequired = failedDestroy && state?.stateAuthority?.state === "BLOCKED";
  const absent = infrastructure?.exists === false || infrastructure?.status === "not_provisioned";
  const provisioningFailed = infrastructure?.status === "provisioning_failed";
  if (cleanupRequired) return <div className="infrastructure-page grid"><PageHeader eyebrow="Infrastructure" title="Destroy cleanup required" status="blocked" /><Card><p className="eyebrow">Runtime is not LIVE</p><h2>Destroy failed after runtime removal or before the previous runtime could be verified.</h2><p>{state?.stateAuthority?.reason || "DeployGuard will not treat historical release evidence as current infrastructure health."}</p><div className="infrastructure-support-grid"><article><span>ECS</span><strong>{label(evidence?.resources?.find((resource) => resource.type === "ECS Fargate")?.status)}</strong></article><article><span>Load balancer</span><strong>{label(evidence?.resources?.find((resource) => resource.type === "ALB")?.status)}</strong></article><article><span>Terraform cleanup</span><strong>{label(evidence?.terraformState?.status)}</strong></article></div><Link className="secondary-button" to={`/projects/${projectId}/pipeline`}>Retry Failed Destroy</Link></Card></div>;
  if (absent) return <div className="infrastructure-page grid"><PageHeader eyebrow="Infrastructure" title="Runtime infrastructure" status="not_provisioned" /><Card><p className="eyebrow">Runtime infrastructure not provisioned</p><h2>Deployment stopped during {state?.progress?.phase === "build" ? "Railpack Build" : "dispatch before runtime provisioning"}.</h2><p>Runtime infrastructure was not provisioned. Open Pipeline for the bounded failure evidence.</p><Link className="secondary-button" to={`/projects/${projectId}/pipeline`}>Open Pipeline</Link></Card></div>;
  if (provisioningFailed) return <div className="infrastructure-page grid"><PageHeader eyebrow="Infrastructure" title="Runtime infrastructure" status="provisioning_failed" /><Card><p className="eyebrow">Provisioning failed</p><h2>Runtime provisioning did not complete.</h2><p>Some resources may exist. Open Pipeline for bounded Terraform evidence.</p><Link className="secondary-button" to={`/projects/${projectId}/pipeline`}>Open Pipeline</Link></Card></div>;
  return <div className="infrastructure-page grid"><PageHeader eyebrow="Infrastructure" title="LIVE service architecture" status={infrastructure?.status || "unavailable"} description="Developer-facing health and persisted release evidence for one authoritative runtime generation." />{error ? <ErrorState message={error} onRetry={() => void load()} /> : null}<section aria-label="Infrastructure summary" className="infrastructure-summary-grid"><MetricCard label="Application" value={state?.stateAuthority?.state === "LIVE" ? "LIVE" : label(state?.stateAuthority?.state)} tone="success" detail={state?.stableUrl || "No public URL"} /><MetricCard label="ECS" value={evidence?.ecs ? `${evidence.ecs.runningCount}/${evidence.ecs.desiredCount}` : "Unavailable"} tone={evidence?.ecs?.runningCount === evidence?.ecs?.desiredCount ? "success" : "neutral"} detail={evidence?.ecs ? `${evidence.ecs.pendingCount} pending` : "No AWS observation"} /><MetricCard label="Load balancer" value={evidence?.alb?.targetHealth?.length ? evidence.alb.targetHealth.map(label).join(", ") : "Unavailable"} tone={evidence?.alb?.targetHealth?.includes("healthy") ? "success" : "neutral"} detail={date(evidence?.lastUpdatedAt)} /><MetricCard label="Region" value={evidence?.region || "Unavailable"} detail="Authoritative runtime region" /></section><ServiceFlow evidence={evidence} state={state} /><SupportingServices evidence={evidence} /><Pricing cost={evidence?.cost} /><TechnicalDetails evidence={evidence} state={state} /></div>;
}
