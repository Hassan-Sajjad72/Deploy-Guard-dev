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
  const live = state?.stateAuthority?.runtime?.state === "present";
  const ecsHealthy = Boolean(evidence?.ecs && evidence.ecs.runningCount >= evidence.ecs.desiredCount && evidence.ecs.pendingCount === 0);
  const albHealthy = evidence?.alb?.targetHealth?.length > 0 && evidence.alb.targetHealth.every((item) => item === "healthy");
  const nodes = [
    { name: "Source", detail: shortened(state?.stableRelease?.commit, 18), available: Boolean(state?.stableRelease?.commit) },
    { name: "Build", detail: live ? "Application image built" : "Unavailable", available: live },
    { name: "ECR", detail: evidence?.ecr?.imageDigest ? "Immutable digest" : "Unavailable", available: Boolean(evidence?.ecr?.imageDigest) },
    { name: "ECS", detail: evidence?.ecs ? `${evidence.ecs.runningCount}/${evidence.ecs.desiredCount} running` : "Unavailable", available: ecsHealthy },
    { name: "ALB", detail: albHealthy ? "Targets healthy" : "Unavailable", available: albHealthy },
    { name: "Application", detail: live ? "LIVE" : "Unavailable", available: live && Boolean(evidence?.alb?.endpoint || state?.stableUrl) },
  ];
  return <Card className="infrastructure-topology-card">
    <div className="infrastructure-section-heading"><div><p className="eyebrow">Current AWS state</p><h2>Source to application</h2></div><span className="infrastructure-source">Generation {shortened(state?.generationState?.liveGenerationId, 20)}</span></div>
    <ol aria-label="Infrastructure service flow" className="infrastructure-topology">{nodes.map((node) => <li data-status={healthStatus(evidence?.terraformState?.status, node.available)} key={node.name}><strong>{node.name}</strong><span>{node.detail}</span><StatusChip status={node.available ? "healthy" : "unavailable"}>{node.available ? "Healthy" : "Unavailable"}</StatusChip></li>)}</ol>
    {evidence?.alb?.endpoint ? <p className="infrastructure-endpoint">Application endpoint: <a href={evidence.alb.endpoint} rel="noreferrer" target="_blank">Open verified application</a></p> : null}
  </Card>;
}

function ServiceRuntimeList({ evidence }) {
  const persisted = Array.isArray(evidence?.runtimeIdentity?.services) ? evidence.runtimeIdentity.services : [];
  const observed = new Map((evidence?.services || []).map((service) => [service.serviceId, service]));
  if (!persisted.length) return null;
  return <Card><div className="infrastructure-section-heading"><div><p className="eyebrow">Services</p><h2>Running applications</h2></div></div><div className="infrastructure-support-grid service-runtime-grid">{persisted.map((service) => { const current = observed.get(service.serviceId); const targets = current?.alb?.targetHealth || []; const healthy = current?.ecs?.runningCount === current?.ecs?.desiredCount && targets.length > 0 && targets.every((state) => state === "healthy"); return <article key={service.serviceId}><div className="service-runtime-heading"><strong>{service.serviceName}</strong><StatusChip status={healthy ? "healthy" : current ? "unhealthy" : "unknown"}>{healthy ? "Healthy" : current ? "Unhealthy" : "Unknown"}</StatusChip></div><span>{service.serviceDirectory || "."}</span><p>Port {service.servicePort || "Unavailable"} · ECS {current ? `${current.ecs.runningCount}/${current.ecs.desiredCount}` : "Unavailable"}</p>{service.publicUrl ? <a href={service.publicUrl} rel="noreferrer" target="_blank">Open ↗</a> : null}</article>; })}</div></Card>;
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
  return <Card className="infrastructure-finops-card"><div className="infrastructure-section-heading"><div><p className="eyebrow">Cost</p><h2>Estimated monthly cost</h2></div><span className="infrastructure-source">{available ? "Infracost" : "Unavailable"}</span></div>
    {available ? <><div className="infrastructure-cost-summary"><MetricCard detail={`Last calculated ${date(cost.estimatedAt)}`} label="Monthly estimate" value={`${cost.currency || "USD"} ${Number(cost.monthly).toFixed(2)} / month`} /></div>{breakdown.length ? <details className="infrastructure-cost-details"><summary>View cost breakdown</summary><ChartCard description="Persisted service estimates." hasData title="Service breakdown"><ol className="infrastructure-cost-bars">{breakdown.map((item) => <li key={`${item.name}-${item.monthly}`}><span>{item.service || item.name}</span><strong>{cost.currency || "USD"} {Number(item.monthly).toFixed(2)}</strong><i style={{ width: `${Math.max(2, (Number(item.monthly) / maximum) * 100)}%` }} /></li>)}</ol></ChartCard></details> : null}</> : <EmptyState icon="activity" message={cost?.unavailableReason || "The current release has no Infracost estimate."} title="Pricing unavailable" />}
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
  for (const service of Array.isArray(identity.services) ? identity.services : []) {
    rows.push([`${service.serviceName} image`, service.imageDigest ? `${service.imageUri}@${service.imageDigest}` : service.imageUri], [`${service.serviceName} ECS service`, service.ecsServiceArn], [`${service.serviceName} task definition`, service.taskDefinitionArn], [`${service.serviceName} endpoint`, service.publicUrl], [`${service.serviceName} log group`, service.cloudWatchLogGroupName]);
  }
  return <Card className="infrastructure-inventory-card"><details className="advanced-resource-details"><summary><span><span className="eyebrow">Advanced</span><strong>Resource details</strong></span><span>Expand</span></summary><DataTable caption="Current release resource identifiers" label="Technical infrastructure details"><thead><tr><th>Resource</th><th>Identifier</th></tr></thead><tbody>{rows.map(([name, value]) => <tr key={name}><td>{name}</td><td>{value ? <CopyValue label="Copy full identifier" value={String(value)} visibleValue={shortened(value, 58)} /> : "Unavailable"}</td></tr>)}</tbody></DataTable></details></Card>;
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
  const destroyRemoved = state?.stateAuthority?.activeOperation?.type === "destroy" && state?.stateAuthority?.runtime?.state === "removed";
  if (cleanupRequired) return <div className="infrastructure-page grid"><PageHeader eyebrow="Infrastructure" title="Destroy cleanup required" status="blocked" /><Card><p className="eyebrow">Runtime is not LIVE</p><h2>Destroy failed after runtime removal or before the previous runtime could be verified.</h2><p>{state?.stateAuthority?.reason || "DeployGuard will not treat historical release evidence as current infrastructure health."}</p><div className="infrastructure-support-grid"><article><span>ECS</span><strong>{label(evidence?.resources?.find((resource) => resource.type === "ECS Fargate")?.status)}</strong></article><article><span>Load balancer</span><strong>{label(evidence?.resources?.find((resource) => resource.type === "ALB")?.status)}</strong></article><article><span>Terraform cleanup</span><strong>{label(evidence?.terraformState?.status)}</strong></article></div><Link className="secondary-button" to={`/projects/${projectId}/pipeline`}>Retry Failed Destroy</Link></Card></div>;
  if (destroyRemoved) return <div className="infrastructure-page grid"><PageHeader eyebrow="Infrastructure" title="Runtime removed · Destroy finalizing" status="destroying" /><Card><p className="eyebrow">Authoritative runtime observation</p><h2>ECS and ALB resources are removed.</h2><p>The Destroy operation remains active while DeployGuard verifies deletion and finalizes control-plane cleanup.</p><Link className="secondary-button" to={`/projects/${projectId}/pipeline`}>View Destroy progress</Link></Card></div>;
  if (absent) return <div className="infrastructure-page grid"><PageHeader eyebrow="Infrastructure" title="Runtime infrastructure" status="not_provisioned" /><Card><p className="eyebrow">Runtime infrastructure not provisioned</p><h2>Deployment stopped during {state?.progress?.phase === "build" ? "Build Application" : "source preparation"}.</h2><p>Runtime infrastructure was not provisioned. Open Pipeline for the bounded failure evidence.</p><Link className="secondary-button" to={`/projects/${projectId}/pipeline`}>Open Pipeline</Link></Card></div>;
  if (provisioningFailed) return <div className="infrastructure-page grid"><PageHeader eyebrow="Infrastructure" title="Runtime infrastructure" status="provisioning_failed" /><Card><p className="eyebrow">Provisioning failed</p><h2>Runtime provisioning did not complete.</h2><p>Some resources may exist. Open Pipeline for bounded Terraform evidence.</p><Link className="secondary-button" to={`/projects/${projectId}/pipeline`}>Open Pipeline</Link></Card></div>;
  const runtimePresent = state?.stateAuthority?.runtime?.state === "present";
  const runtimeTitle = runtimePresent ? (state?.stateAuthority?.state === "DESTROYING" ? "Runtime healthy · Destroy in progress" : failedDestroy ? "Runtime healthy · Latest Destroy failed" : "Runtime service architecture") : "Runtime infrastructure state";
  const observedServices = Array.isArray(evidence?.services) ? evidence.services : [];
  const runningServices = observedServices.filter((service) => service?.ecs?.runningCount === service?.ecs?.desiredCount).length;
  const targetHealth = observedServices.flatMap((service) => service?.alb?.targetHealth || []);
  const healthyTargets = targetHealth.filter((target) => target === "healthy").length;
  return <div className="infrastructure-page grid"><PageHeader eyebrow="Infrastructure" title={runtimeTitle} status={infrastructure?.status || "unavailable"} description="Current AWS state for this release." />{error ? <ErrorState message={error} onRetry={() => void load()} /> : null}<section aria-label="Infrastructure summary" className="infrastructure-summary-grid"><MetricCard label="Application" value={runtimePresent ? (state?.stableUrl ? <a href={state.stableUrl} rel="noreferrer" target="_blank">Open application ↗</a> : "Healthy") : label(state?.stateAuthority?.runtime?.state)} tone={runtimePresent ? "success" : "neutral"} /><MetricCard label="Services" value={observedServices.length ? `${runningServices}/${observedServices.length} running` : evidence?.ecs ? `${evidence.ecs.runningCount}/${evidence.ecs.desiredCount} running` : "Unavailable"} tone={observedServices.length && runningServices === observedServices.length ? "success" : "neutral"} /><MetricCard label="Targets" value={targetHealth.length ? `${healthyTargets}/${targetHealth.length} healthy` : evidence?.alb?.targetHealth?.length ? `${evidence.alb.targetHealth.filter((item) => item === "healthy").length}/${evidence.alb.targetHealth.length} healthy` : "Unavailable"} tone={(targetHealth.length && healthyTargets === targetHealth.length) || (evidence?.alb?.targetHealth?.length && evidence.alb.targetHealth.every((item) => item === "healthy")) ? "success" : "neutral"} /><MetricCard label="Region" value={evidence?.region || "Unavailable"} /></section><ServiceFlow evidence={evidence} state={state} /><ServiceRuntimeList evidence={evidence} /><SupportingServices evidence={evidence} /><Pricing cost={evidence?.cost} /><TechnicalDetails evidence={evidence} state={state} /></div>;
}
