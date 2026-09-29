import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { createTerraformExport, downloadTerraformExport } from "../api/platformApi.js";
import { getProjectDetailedCurrentState } from "../api/projectApi.js";
import { Card, ChartCard, CopyValue, DataTable, EmptyState, MetricCard, PageHeader, StatusChip } from "../components/common/DesignSystem.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { useToast } from "../hooks/useToast.js";
import { redirectDeletedProject, subscribeProjectStateChanged } from "../utils/projectStateSync.js";
import { projectStatePresentation } from "../utils/projectStatePresentation.js";
import AppIcon from "../components/common/AppIcon.jsx";
import "../styles/pages/infrastructure.css";

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

function healthStatus(value, available, updating = false) {
  return available ? "active" : updating ? "pending" : value === "destroyed" ? "historical" : "unavailable";
}

function TerraformExportAction({ projectId }) {
  const { notify } = useToast();
  const [exporting, setExporting] = useState(false);

  async function exportTerraform() {
    setExporting(true);
    try {
      const artifact = await createTerraformExport(projectId);
      await downloadTerraformExport(projectId, artifact);
      notify(`Terraform export downloaded as ${artifact.filename}.`, "success");
    } catch (caught) {
      notify(caught.message || "Terraform export failed.", "danger");
    } finally {
      setExporting(false);
    }
  }

  return <button aria-busy={exporting} className="secondary-button" disabled={exporting} onClick={exportTerraform} type="button">{exporting ? "Preparing export…" : "Export Terraform"}</button>;
}

function hostOf(url) {
  try { return url ? new URL(url).host : null; } catch { return null; }
}

function TopologyNode({ id, icon, name, detail, status = "off", aws = false, selected, onSelect, className = "" }) {
  return <button aria-pressed={selected === id} className={`itw-node is-${status}${aws ? " is-aws" : ""}${className ? ` ${className}` : ""}`} data-node={id} onClick={() => onSelect(id)} type="button">
    <span aria-hidden="true" className="itw-node-icon"><AppIcon name={icon} size={17} /></span>
    <span className="itw-node-copy"><strong>{name}</strong><small>{detail}</small></span>
    {status !== "off" ? <span aria-label={status === "ok" ? "Healthy" : status === "warn" ? "Updating" : "Attention"} className="itw-node-dot" role="img" /> : null}
  </button>;
}

function TopologyLink({ caption, id, vertical = false }) {
  return <span aria-hidden="true" className={vertical ? "itw-link is-vertical" : "itw-link"} data-link={id}>{caption ? <em>{caption}</em> : null}</span>;
}

function value(item) {
  return item === null || item === undefined || item === "" ? "Unavailable" : String(item);
}

/**
 * Deployed topology workspace drawn only from canonical infrastructure
 * evidence. Resources without evidence (subnets, DNS provider, database) are
 * not invented. Selecting a resource highlights its traffic path and opens
 * the recorded evidence for that resource in the inspector.
 */
function TopologyMap({ state, evidence, updating }) {
  const persisted = Array.isArray(evidence?.runtimeIdentity?.services) ? evidence.runtimeIdentity.services : [];
  const identity = evidence?.runtimeIdentity || {};
  const observed = Array.isArray(evidence?.services) ? evidence.services : [];
  const services = observed.length
    ? observed.map((service) => { const record = persisted.find((item) => item.serviceId === service.serviceId); return { id: service.serviceId, name: service.serviceName, ecs: service.ecs, targets: (service.alb?.targetHealth || []).filter((target) => target !== "draining"), port: record?.servicePort, directory: record?.serviceDirectory, publicUrl: service.publicUrl || record?.publicUrl, imageDigest: service.imageDigest }; })
    : evidence?.ecs ? [{ id: evidence.ecs.service, name: evidence.ecs.service, ecs: evidence.ecs, targets: (evidence?.alb?.targetHealth || []).filter((target) => target !== "draining"), port: null }] : [];
  const allTargets = services.flatMap((service) => service.targets);
  const healthyTargets = allTargets.filter((target) => target === "healthy").length;
  const albHealthy = allTargets.length > 0 && healthyTargets === allTargets.length;
  const host = hostOf(state?.stableUrl);
  const storage = evidence?.persistentStorage;
  const statusFor = (healthy) => healthy ? "ok" : updating ? "warn" : "bad";
  const serviceHealthy = (service) => Boolean(service.ecs && service.ecs.runningCount === service.ecs.desiredCount && service.targets.length > 0 && service.targets.every((target) => target === "healthy"));
  const [selected, setSelected] = useState(allTargets.length ? "alb" : services[0] ? `svc:${services[0].id}` : "internet");

  const selectedService = selected.startsWith("svc:") ? services.find((service) => `svc:${service.id}` === selected) : null;
  const paths = { internet: "internet", endpoint: "internet endpoint", alb: "internet endpoint alb", efs: "efs", ecr: "ecr", cloudwatch: "cloudwatch", terraform: "terraform" };
  const activePath = selectedService ? "internet endpoint alb services" : paths[selected] || "";
  const inspector = selectedService ? {
    title: selectedService.name || "ECS service", kind: "ECS Fargate service", status: statusFor(serviceHealthy(selectedService)),
    rows: [["ECS service", selectedService.ecs?.service], ["Tasks", selectedService.ecs ? `${selectedService.ecs.runningCount} running / ${selectedService.ecs.desiredCount} desired` : null], ["Pending", selectedService.ecs?.pendingCount], ["Port", selectedService.port], ["Directory", selectedService.directory], ["Targets", selectedService.targets.length ? `${selectedService.targets.filter((target) => target === "healthy").length}/${selectedService.targets.length} healthy` : "No load balancer targets"], ["Public URL", selectedService.publicUrl], ["Image digest", selectedService.imageDigest ? shortened(selectedService.imageDigest, 30) : null]],
  } : {
    internet: { title: "Internet", kind: "Public traffic", status: "off", rows: [["Entry point", host || "No verified route"]] },
    endpoint: { title: "Public endpoint", kind: "Verified project route", status: host ? "ok" : "off", rows: [["Host", host], ["URL", state?.stableUrl]] },
    alb: { title: "Application Load Balancer", kind: "AWS · Elastic Load Balancing", status: allTargets.length ? statusFor(albHealthy) : "off", rows: [["Name", evidence?.alb?.name || identity.albName], ["Status", evidence?.alb?.status ? label(evidence.alb.status) : null], ["Targets", allTargets.length ? `${healthyTargets}/${allTargets.length} healthy` : updating ? "Release updating" : null], ["Target group", identity.targetGroupName], ["Region", evidence?.region]] },
    efs: { title: "EFS storage", kind: "AWS · Elastic File System", status: storage?.status === "active" ? "ok" : "off", rows: [["Status", storage ? label(storage.status) : null], ["Encrypted", storage ? (storage.encrypted ? "Yes" : "No") : null], ["Backups", storage ? (storage.backupEnabled ? "Enabled" : "Disabled") : null], ["Region", storage?.region]] },
    ecr: { title: "Amazon ECR", kind: "AWS · Container registry", status: evidence?.ecr?.imageDigest ? "ok" : "off", rows: [["Repository", evidence?.ecr?.repository], ["Image tag", evidence?.ecr?.imageTag], ["Digest", evidence?.ecr?.imageDigest ? shortened(evidence.ecr.imageDigest, 30) : null]] },
    cloudwatch: { title: "CloudWatch", kind: "AWS · Logs and metrics", status: evidence?.cloudWatch?.status === "active" ? "ok" : "off", rows: [["Status", label(evidence?.cloudWatch?.status)], ["Log group", identity.cloudWatchLogGroupName]] },
    terraform: { title: "Terraform state", kind: "Infrastructure state", status: evidence?.terraformState?.status === "active" ? "ok" : "off", rows: [["Status", label(evidence?.terraformState?.status)], ["Storage", evidence?.terraformState?.storage === "encrypted_s3" ? "Encrypted S3" : evidence?.terraformState?.storage], ["State key", evidence?.terraformState?.key ? shortened(evidence.terraformState.key, 34) : null], ["Last apply", evidence?.terraformState?.lastApplyAt ? date(evidence.terraformState.lastApplyAt) : null]] },
  }[selected] || null;
  const node = ({ key, ...props }) => <TopologyNode key={key} onSelect={setSelected} selected={selected} {...props} />;

  return <section aria-labelledby="itm-title" className="infra-topology-map itw">
    <header className="itw-bar">
      <div><p className="eyebrow">Deployed topology</p><h2 id="itm-title">Runtime architecture</h2></div>
      <div className="itw-bar-meta">
        <span className="itw-chip"><AppIcon name="infrastructure" size={13} />AWS · {evidence?.region || "Region unavailable"}</span>
        <span className="itw-chip">{services.length} service{services.length === 1 ? "" : "s"}</span>
        <span className="itm-legend"><i className="is-ok" />Healthy<i className="is-warn" />Updating<i className="is-bad" />Attention</span>
      </div>
    </header>
    <div className="itw-body">
      <div className="itw-canvas" data-path={activePath}>
        <div className="itw-edge">
          <span className="itw-tier">Public edge</span>
          {node({ id: "internet", detail: "Public traffic", icon: "user", name: "Internet" })}
          <TopologyLink caption="requests" id="endpoint" vertical />
          {node({ id: "endpoint", detail: host || "No verified route", icon: "activity", name: "Public endpoint", status: host ? "ok" : "off" })}
        </div>
        <TopologyLink caption="routes" id="alb" />
        <div className="itw-aws">
          <span className="itw-boundary-label">AWS Cloud · {evidence?.region || "Region unavailable"}</span>
          <div className="itw-aws-main">
            <div className="itw-ingress">
              <span className="itw-tier">Ingress</span>
              {node({ aws: true, className: "is-hub", detail: allTargets.length ? `${healthyTargets}/${allTargets.length} targets healthy` : updating ? "Release updating" : "No target evidence", icon: "branch", id: "alb", name: "Application Load Balancer", status: allTargets.length ? statusFor(albHealthy) : "off" })}
            </div>
            <TopologyLink caption="targets" id="services" />
            <div className="itw-vpc">
              <span className="itw-boundary-label">VPC · ECS Fargate</span>
              <div className="itw-bus">
                {services.map((service) => node({ aws: true, className: "is-service", detail: `${service.ecs ? `${service.ecs.runningCount}/${service.ecs.desiredCount} tasks` : "No task evidence"}${service.port ? ` · port ${service.port}` : ""}`, icon: "infrastructure", id: `svc:${service.id}`, key: service.id, name: service.name || "ECS service", status: statusFor(serviceHealthy(service)) }))}
                {!services.length ? <p className="itm-empty">{updating ? "Release updating — ECS evidence pending." : "No ECS service evidence for this release."}</p> : null}
              </div>
              {storage ? <div className="itw-storage">{node({ aws: true, detail: `${label(storage.status)}${storage.encrypted ? " · encrypted" : ""}${storage.backupEnabled ? " · backups" : ""}`, icon: "storage", id: "efs", name: "EFS storage", status: storage.status === "active" ? "ok" : "off" })}</div> : null}
            </div>
          </div>
          <div className="itw-support" aria-label="Supporting services">
            <span className="itw-tier">Supporting resources</span>
            {node({ aws: true, detail: evidence?.ecr?.imageDigest ? `digest ${shortened(evidence.ecr.imageDigest, 22)}` : "No image evidence", icon: "box", id: "ecr", name: "Amazon ECR", status: evidence?.ecr?.imageDigest ? "ok" : "off" })}
            {node({ aws: true, detail: evidence?.cloudWatch?.status === "active" ? "Log group observed" : label(evidence?.cloudWatch?.status), icon: "logs", id: "cloudwatch", name: "CloudWatch", status: evidence?.cloudWatch?.status === "active" ? "ok" : "off" })}
            {node({ detail: evidence?.terraformState?.status === "active" ? `State active${evidence.terraformState.storage === "encrypted_s3" ? " · encrypted S3" : ""}` : label(evidence?.terraformState?.status), icon: "state", id: "terraform", name: "Terraform state", status: evidence?.terraformState?.status === "active" ? "ok" : "off" })}
          </div>
        </div>
      </div>
      {inspector ? <aside aria-label="Selected resource" aria-live="polite" className={`itw-inspector is-${inspector.status}`}>
        <p className="eyebrow">Selected resource</p>
        <h3>{inspector.title}</h3>
        <span className="itw-kind">{inspector.kind}</span>
        <div className="itw-props">{inspector.rows.map(([name, item]) => <div className="itw-prop" key={name}><span>{name}</span><strong className={item === null || item === undefined || item === "" ? "is-empty" : ""}>{value(item)}</strong></div>)}</div>
        <p className="itw-hint">Select any resource in the topology to inspect its recorded evidence.</p>
      </aside> : null}
    </div>
  </section>;
}

function ServiceFlow({ state, evidence }) {
  const live = state?.stateAuthority?.runtime?.state === "present";
  const updating = Boolean(state?.stateAuthority?.activeOperation && state.stateAuthority.activeOperation.type !== "destroy");
  const ecsHealthy = Boolean(evidence?.ecs && evidence.ecs.runningCount >= evidence.ecs.desiredCount && evidence.ecs.pendingCount === 0);
  const activeTargets = (evidence?.alb?.targetHealth || []).filter((item) => item !== "draining");
  const albHealthy = activeTargets.length > 0 && activeTargets.every((item) => item === "healthy");
  const nodes = [
    { name: "Source", detail: shortened(state?.stableRelease?.commit, 18), available: Boolean(state?.stableRelease?.commit) },
    { name: "Build", detail: live ? "Application image built" : "Unavailable", available: live },
    { name: "ECR", detail: evidence?.ecr?.imageDigest ? "Immutable digest" : updating ? "Release updating" : "Unavailable", available: Boolean(evidence?.ecr?.imageDigest), updating },
    { name: "ECS", detail: evidence?.ecs ? `${evidence.ecs.runningCount}/${evidence.ecs.desiredCount} running` : updating ? "Release updating" : "Unavailable", available: ecsHealthy, updating },
    { name: "ALB", detail: albHealthy ? "Targets healthy" : updating ? "Release updating" : "Unavailable", available: albHealthy, updating },
    { name: "Application", detail: live ? "LIVE" : "Unavailable", available: live && Boolean(evidence?.alb?.endpoint || state?.stableUrl) },
  ];
  return <Card className="infrastructure-topology-card">
    <div className="infrastructure-section-heading"><div><p className="eyebrow">Current AWS state</p><h2>Source to application</h2></div><span className="infrastructure-source">Generation {shortened(state?.generationState?.liveGenerationId, 20)}</span></div>
    <ol aria-label="Infrastructure service flow" className="infrastructure-topology">{nodes.map((node) => <li data-status={healthStatus(evidence?.terraformState?.status, node.available, node.updating)} key={node.name}><strong>{node.name}</strong><span>{node.detail}</span><StatusChip status={node.available ? "healthy" : node.updating ? "running" : "unavailable"}>{node.available ? "Healthy" : node.updating ? "Updating" : "Unavailable"}</StatusChip></li>)}</ol>
    {evidence?.alb?.endpoint ? <p className="infrastructure-endpoint">Application endpoint: <a href={evidence.alb.endpoint} rel="noreferrer" target="_blank">Open verified application</a></p> : null}
  </Card>;
}

function ServiceRuntimeList({ evidence, transitioning = false }) {
  const persisted = Array.isArray(evidence?.runtimeIdentity?.services) ? evidence.runtimeIdentity.services : [];
  const observed = new Map((evidence?.services || []).map((service) => [service.serviceId, service]));
  if (!persisted.length) return null;
  return <Card><div className="infrastructure-section-heading"><div><p className="eyebrow">Services</p><h2>Running applications</h2></div></div><div className="infrastructure-support-grid service-runtime-grid">{persisted.map((service) => { const current = observed.get(service.serviceId); const targets = (current?.alb?.targetHealth || []).filter((state) => state !== "draining"); const healthy = current?.ecs?.runningCount === current?.ecs?.desiredCount && targets.length > 0 && targets.every((state) => state === "healthy"); const updating = transitioning && !current; return <article key={service.serviceId}><div className="service-runtime-heading"><strong>{service.serviceName}</strong><StatusChip status={healthy ? "healthy" : updating ? "running" : current ? "unhealthy" : "unknown"}>{healthy ? "Healthy" : updating ? "Updating" : current ? "Unhealthy" : "Unknown"}</StatusChip></div><span>{service.serviceDirectory || "."}</span><p>Port {service.servicePort || "Unavailable"} · ECS {current ? `${current.ecs.runningCount}/${current.ecs.desiredCount}` : updating ? "Release updating" : "Unavailable"}</p>{service.publicUrl ? <a href={service.publicUrl} rel="noreferrer" target="_blank">Open ↗</a> : null}</article>; })}</div></Card>;
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
  const navigate = useNavigate();
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => { try { setError(""); setState(await getProjectDetailedCurrentState(projectId)); } catch (caught) { if (!redirectDeletedProject(caught, navigate)) setError(caught.message); } }, [navigate, projectId]);
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
  const exportAction = <TerraformExportAction projectId={projectId} />;
  if (cleanupRequired) return <div className="infrastructure-page grid"><PageHeader actions={exportAction} eyebrow="Infrastructure" title="Destroy cleanup required" status="blocked" /><Card><p className="eyebrow">Runtime is not LIVE</p><h2>Destroy failed after runtime removal or before the previous runtime could be verified.</h2><p>{state?.stateAuthority?.reason || "DeployGuard will not treat historical release evidence as current infrastructure health."}</p><div className="infrastructure-support-grid"><article><span>ECS</span><strong>{label(evidence?.resources?.find((resource) => resource.type === "ECS Fargate")?.status)}</strong></article><article><span>Load balancer</span><strong>{label(evidence?.resources?.find((resource) => resource.type === "ALB")?.status)}</strong></article><article><span>Terraform cleanup</span><strong>{label(evidence?.terraformState?.status)}</strong></article></div><Link className="secondary-button" to={`/projects/${projectId}/pipeline`}>Retry Failed Destroy</Link></Card></div>;
  if (destroyRemoved) return <div className="infrastructure-page grid"><PageHeader actions={exportAction} eyebrow="Infrastructure" title="Runtime removed · Destroy finalizing" status="destroying" /><Card><p className="eyebrow">Authoritative runtime observation</p><h2>ECS and ALB resources are removed.</h2><p>The Destroy operation remains active while DeployGuard verifies deletion and finalizes control-plane cleanup.</p><Link className="secondary-button" to={`/projects/${projectId}/pipeline`}>View Destroy progress</Link></Card></div>;
  if (absent) return <div className="infrastructure-page grid"><PageHeader actions={exportAction} eyebrow="Infrastructure" title="Runtime infrastructure" status="not_provisioned" /><Card><p className="eyebrow">Runtime infrastructure not provisioned</p><h2>Deployment stopped during {state?.progress?.phase === "build" ? "Build Application" : "source preparation"}.</h2><p>Runtime infrastructure was not provisioned. Open Pipeline for the bounded failure evidence.</p><Link className="secondary-button" to={`/projects/${projectId}/pipeline`}>Open Pipeline</Link></Card></div>;
  if (provisioningFailed) return <div className="infrastructure-page grid"><PageHeader actions={exportAction} eyebrow="Infrastructure" title="Runtime infrastructure" status="provisioning_failed" /><Card><p className="eyebrow">Provisioning failed</p><h2>Runtime provisioning did not complete.</h2><p>Some resources may exist. Open Pipeline for bounded Terraform evidence.</p><Link className="secondary-button" to={`/projects/${projectId}/pipeline`}>Open Pipeline</Link></Card></div>;
  const runtimePresent = state?.stateAuthority?.runtime?.state === "present";
  const releaseUpdating = Boolean(state?.stateAuthority?.activeOperation && state.stateAuthority.activeOperation.type !== "destroy");
  const runtimeTitle = runtimePresent ? (state?.stateAuthority?.state === "DESTROYING" ? "Runtime healthy · Destroy in progress" : failedDestroy ? "Runtime healthy · Latest Destroy failed" : "Runtime service architecture") : "Runtime infrastructure state";
  const observedServices = Array.isArray(evidence?.services) ? evidence.services : [];
  const runningServices = observedServices.filter((service) => service?.ecs?.runningCount === service?.ecs?.desiredCount).length;
  const targetHealth = observedServices.length
    ? observedServices.flatMap((service) => service?.alb?.targetHealth || [])
    : evidence?.alb?.targetHealth || [];
  const activeTargetHealth = targetHealth.filter((target) => target !== "draining");
  const drainingTargets = targetHealth.filter((target) => target === "draining").length;
  const healthyTargets = activeTargetHealth.filter((target) => target === "healthy").length;
  const targetsHealthy = activeTargetHealth.length > 0 && healthyTargets === activeTargetHealth.length;
  return <div className="infrastructure-page grid dg-infra"><PageHeader actions={exportAction} eyebrow="Infrastructure" title={releaseUpdating ? "Runtime release updating" : runtimeTitle} status={infrastructure?.status || "unavailable"} description={releaseUpdating ? "The previous LIVE release remains canonical while AWS activates the candidate release." : "Current AWS state for this release."} />{error ? <ErrorState message={error} onRetry={() => void load()} /> : null}
    <TopologyMap evidence={evidence} state={state} updating={releaseUpdating} />
    <section aria-label="Infrastructure summary" className="infrastructure-summary-grid"><MetricCard label="Application" value={runtimePresent ? (state?.stableUrl ? <a href={state.stableUrl} rel="noreferrer" target="_blank">Open application ↗</a> : "Healthy") : label(state?.stateAuthority?.runtime?.state)} tone={runtimePresent ? "success" : "neutral"} /><MetricCard label="Services" value={observedServices.length ? `${runningServices}/${observedServices.length} running` : releaseUpdating ? "Release updating" : evidence?.ecs ? `${evidence.ecs.runningCount}/${evidence.ecs.desiredCount} running` : "Unavailable"} tone={observedServices.length && runningServices === observedServices.length ? "success" : "neutral"} /><MetricCard label="Targets" value={activeTargetHealth.length ? `${healthyTargets}/${activeTargetHealth.length} healthy${drainingTargets ? ` · ${drainingTargets} draining` : ""}` : releaseUpdating ? "Release updating" : "Unavailable"} tone={targetsHealthy ? "success" : "neutral"} /><MetricCard label="Region" value={evidence?.region || "Unavailable"} /></section>
    <div className="infra-columns"><div className="infra-column-main"><ServiceRuntimeList evidence={evidence} transitioning={releaseUpdating} /><ServiceFlow evidence={evidence} state={state} /></div><div className="infra-column-side"><Pricing cost={evidence?.cost} /><SupportingServices evidence={evidence} /></div></div>
    <TechnicalDetails evidence={evidence} state={state} /></div>;
}
