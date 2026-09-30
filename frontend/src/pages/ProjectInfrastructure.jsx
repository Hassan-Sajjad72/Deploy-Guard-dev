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

function label(value) {
  return value ? String(value).replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : null;
}

function date(value) {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp)) : null;
}

function shortened(value, max = 34) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value);
  return text.length > max ? `${text.slice(0, max - 10)}…${text.slice(-8)}` : text;
}

function reported(value) {
  return value !== null && value !== undefined && value !== "" && String(value).toLowerCase() !== "unavailable";
}

function TerraformExportAction({ projectId }) {
  const { notify } = useToast();
  const [exporting, setExporting] = useState(false);

  async function exportTerraform() {
    setExporting(true);
    try {
      const artifact = await createTerraformExport(projectId);
      await downloadTerraformExport(projectId, artifact);
      notify(`Infrastructure code export downloaded as ${artifact.filename}.`, "success");
    } catch (caught) {
      notify(caught.message || "Infrastructure code export failed.", "danger");
    } finally {
      setExporting(false);
    }
  }

  return <button aria-busy={exporting} className="secondary-button" disabled={exporting} onClick={exportTerraform} type="button">{exporting ? "Preparing export…" : "Export infrastructure code"}</button>;
}

function hostOf(url) {
  try { return url ? new URL(url).host : null; } catch { return null; }
}

function TopologyNode({ id, icon, name, detail, status = "off", statusLabel, aws = false, selected, onSelect, className = "" }) {
  return <button aria-pressed={selected === id} className={`itw-node is-${status}${aws ? " is-aws" : ""}${className ? ` ${className}` : ""}`} data-node={id} onClick={() => onSelect(id)} type="button">
    <span aria-hidden="true" className="itw-node-icon"><AppIcon name={icon} size={17} /></span>
    <span className="itw-node-copy"><strong>{name}</strong><small>{detail}</small></span>
    {status !== "off" ? <span aria-label={statusLabel || (status === "ok" ? "Healthy" : status === "warn" ? "Needs attention" : "Failure") } className="itw-node-dot" role="img" /> : null}
  </button>;
}

function TopologyLink({ caption, id, vertical = false }) {
  return <span aria-hidden="true" className={vertical ? "itw-link is-vertical" : "itw-link"} data-link={id}>{caption ? <em>{caption}</em> : null}</span>;
}

function value(item) {
  return String(item);
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
    ? observed.map((service) => { const record = persisted.find((item) => item.serviceId === service.serviceId); return { id: service.serviceId, name: service.serviceName, ecs: service.ecs, targets: (service.alb?.targetHealth || []).filter(reported).map((target) => String(target).toLowerCase()).filter((target) => target !== "draining"), targetGroupArn: record?.targetGroupArn, port: record?.servicePort, directory: record?.serviceDirectory, publicUrl: service.publicUrl || record?.publicUrl, imageDigest: service.imageDigest }; })
    : evidence?.ecs ? [{ id: evidence.ecs.service, name: evidence.ecs.service, ecs: evidence.ecs, targets: (evidence?.alb?.targetHealth || []).filter(reported).map((target) => String(target).toLowerCase()).filter((target) => target !== "draining"), targetGroupArn: identity.targetGroupArn, port: null }] : [];
  const allTargets = services.flatMap((service) => service.targets);
  const healthyTargets = allTargets.filter((target) => target === "healthy").length;
  const hasUnhealthyTarget = allTargets.includes("unhealthy");
  const albHealthy = allTargets.length > 0 && healthyTargets === allTargets.length;
  const host = hostOf(state?.stableUrl);
  const storage = evidence?.persistentStorage;
  const taskDefinitions = [
    ...(reported(identity.taskDefinitionArn) ? [{ name: "Application", value: identity.taskDefinitionArn }] : []),
    ...(Array.isArray(identity.services) ? identity.services.filter((service) => reported(service.taskDefinitionArn)).map((service) => ({ name: service.serviceName || "Application service", value: service.taskDefinitionArn })) : []),
  ];
  const hasAlbEvidence = Boolean(reported(evidence?.alb?.status) || evidence?.alb?.targetHealth?.some(reported) || allTargets.length || [identity.albArn, identity.albName, identity.targetGroupArn, identity.targetGroupName].some(reported));
  const hasEcrEvidence = Boolean(reported(evidence?.ecr?.repository) || reported(evidence?.ecr?.imageDigest));
  const hasCloudWatchEvidence = Boolean(reported(evidence?.cloudWatch?.status) || reported(evidence?.cloudWatch?.logGroupName) || reported(identity.cloudWatchLogGroupName));
  const hasTerraformEvidence = Boolean(reported(evidence?.terraformState?.status) || reported(evidence?.terraformState?.key) || reported(identity.terraformStateKey));
  const hasRuntimeResource = Boolean(hasAlbEvidence || services.length || storage);
  const hasRoutedServices = services.some((service) => reported(service.targetGroupArn) || service.targets.length);
  const hasRegionEvidence = Boolean(identity.region || evidence?.ecs || evidence?.ecr || evidence?.alb || observed.length);
  const region = hasRegionEvidence && reported(evidence?.region) ? evidence.region : null;
  const statusFor = (healthy, failed = false) => healthy ? "ok" : failed ? "bad" : updating ? "warn" : "off";
  const supportStatus = (status) => {
    const normalized = String(status || "").toLowerCase();
    if (["failed", "error", "unhealthy"].includes(normalized)) return "bad";
    if (["degraded", "updating", "pending"].includes(normalized)) return "warn";
    return normalized === "active" ? "ok" : "off";
  };
  const serviceHealthy = (service) => Boolean(service.ecs && service.ecs.runningCount === service.ecs.desiredCount && service.targets.length > 0 && service.targets.every((target) => target === "healthy"));
  const serviceStatus = (service) => {
    if (serviceHealthy(service)) return "ok";
    if (service.targets.includes("unhealthy")) return "bad";
    if (updating) return "warn";
    if (Number.isFinite(service.ecs?.runningCount) && Number.isFinite(service.ecs?.desiredCount) && service.ecs.runningCount !== service.ecs.desiredCount) return "warn";
    return "off";
  };
  const serviceStatusLabel = (service) => serviceHealthy(service) ? "Healthy"
    : service.targets.includes("unhealthy") ? "Unhealthy"
      : updating ? "Updating"
        : Number.isFinite(service.ecs?.runningCount) && Number.isFinite(service.ecs?.desiredCount) && service.ecs.runningCount !== service.ecs.desiredCount ? "Degraded"
          : "Health not observed";
  const [selected, setSelected] = useState(allTargets.length ? "alb" : services[0] ? `svc:${services[0].id}` : "internet");

  const selectedService = selected.startsWith("svc:") ? services.find((service) => `svc:${service.id}` === selected) : null;
  const endpointPath = host ? "internet endpoint" : "internet";
  const linkedServicePath = host && hasAlbEvidence && hasRoutedServices ? "internet endpoint alb services" : hasAlbEvidence && hasRoutedServices ? "alb services" : "services";
  const paths = { internet: "internet", endpoint: endpointPath, alb: hasAlbEvidence ? `${endpointPath} alb` : endpointPath, efs: storage ? "efs" : "" };
  const activePath = selectedService ? linkedServicePath : paths[selected] || "";
  const inspector = selectedService ? {
    title: selectedService.name || "Application service", kind: "Application service", status: serviceStatus(selectedService),
    rows: [["Tasks", Number.isFinite(selectedService.ecs?.runningCount) && Number.isFinite(selectedService.ecs?.desiredCount) ? `${selectedService.ecs.runningCount} running / ${selectedService.ecs.desiredCount} desired` : null], ["Pending", Number.isFinite(selectedService.ecs?.pendingCount) ? selectedService.ecs.pendingCount : null], ["Directory", selectedService.directory], ["Health", selectedService.targets.length ? `${selectedService.targets.filter((target) => target === "healthy").length}/${selectedService.targets.length} healthy` : null], ["Public URL", selectedService.publicUrl]],
  } : {
    internet: { title: "Internet", kind: "Public traffic", status: "off", rows: [["Entry point", host || "No verified route"]] },
    endpoint: { title: "Public endpoint", kind: "Verified project route", status: "off", rows: [["Host", host], ["URL", state?.stableUrl]] },
    alb: { title: "Load balancer", kind: "Traffic routing", status: statusFor(albHealthy, hasUnhealthyTarget), rows: [["Status", reported(evidence?.alb?.status) ? label(evidence.alb.status) : null], ["Health", allTargets.length ? `${healthyTargets}/${allTargets.length} healthy` : updating ? "Release updating" : null], ["Region", region]] },
    efs: { title: "Data storage", kind: "Persistent application data", status: storage?.status === "active" ? "ok" : "off", rows: [["Status", reported(storage?.status) ? label(storage.status) : null], ["Encrypted", typeof storage?.encrypted === "boolean" ? (storage.encrypted ? "Yes" : "No") : null], ["Backups", typeof storage?.backupEnabled === "boolean" ? (storage.backupEnabled ? "Enabled" : "Disabled") : null], ["Region", reported(storage?.region) ? storage.region : null]] },
    ecr: { title: "Image registry", kind: "Container image storage", status: supportStatus(evidence?.ecr?.status), rows: [["Status", reported(evidence?.ecr?.status) ? label(evidence.ecr.status) : null], ["Image tag", evidence?.ecr?.imageTag], ["Digest", evidence?.ecr?.imageDigest ? "Image digest recorded" : null]] },
    cloudwatch: { title: "Application logs", kind: "Log storage", status: supportStatus(evidence?.cloudWatch?.status), rows: [["Status", reported(evidence?.cloudWatch?.status) ? label(evidence.cloudWatch.status) : null], ["Log group", evidence?.cloudWatch?.logGroupName ? "Observed" : identity.cloudWatchLogGroupName ? "Configured" : null]] },
    terraform: { title: "State storage", kind: "Infrastructure state", status: supportStatus(evidence?.terraformState?.status), rows: [["Status", reported(evidence?.terraformState?.status) ? label(evidence.terraformState.status) : null], ["Storage", evidence?.terraformState?.storage === "encrypted_s3" ? "Encrypted storage" : reported(evidence?.terraformState?.storage) ? evidence.terraformState.storage : null], ["State evidence", evidence?.terraformState?.key || identity.terraformStateKey ? "Recorded" : null], ["Last apply", date(evidence?.terraformState?.lastApplyAt)]] },
    tasks: { title: "Runtime revisions", kind: "Recorded application revisions", status: "off", rows: [["Recorded revisions", taskDefinitions.length || null]] },
  }[selected] || null;
  const node = ({ key, ...props }) => <TopologyNode key={key} onSelect={setSelected} selected={selected} {...props} />;

  return <section aria-labelledby="itm-title" className="infra-topology-map itw">
    <header className="itw-bar">
      <div><h2 id="itm-title">Application architecture</h2><p>How traffic reaches the current application.</p></div>
      <div className="itw-bar-meta">
        {region ? <span className="itw-chip"><AppIcon name="infrastructure" size={13} />{region}</span> : null}
        <span className="itw-chip">{services.length} service{services.length === 1 ? "" : "s"}</span>
      </div>
    </header>
    <div className="itw-body">
      <div className={`itw-canvas${host && hasAlbEvidence ? " has-linked-architecture" : ""}`} data-path={activePath}>
        <div className="itw-edge">
          <span className="itw-tier">Public traffic</span>
          {node({ id: "internet", detail: "Public traffic", icon: "user", name: "Internet" })}
          {host ? <><TopologyLink caption="requests" id="endpoint" vertical />{node({ id: "endpoint", detail: host, icon: "activity", name: "Public endpoint" })}</> : null}
        </div>
        {host && hasAlbEvidence ? <TopologyLink caption="routes" id="alb" /> : null}
        {hasRuntimeResource ? <div className="itw-aws">
          <span className="itw-boundary-label">Runtime resources</span>
          <div className={`itw-aws-main${hasAlbEvidence && hasRoutedServices ? " has-service-route" : " is-disconnected"}`}>
            {hasAlbEvidence ? <div className="itw-ingress">
              <span className="itw-tier">Ingress</span>
              {node({ aws: true, className: "is-hub", detail: allTargets.length ? `${healthyTargets} of ${allTargets.length} targets healthy` : reported(evidence?.alb?.status) ? label(evidence.alb.status) : updating ? "Health observation pending" : "Resource identity recorded", icon: "branch", id: "alb", name: "Load balancer", status: allTargets.length ? statusFor(albHealthy, hasUnhealthyTarget) : supportStatus(evidence?.alb?.status), statusLabel: hasUnhealthyTarget ? "Unhealthy" : updating ? "Updating" : albHealthy ? "Healthy" : "Status not observed" })}
            </div> : null}
            {hasAlbEvidence && hasRoutedServices ? <TopologyLink caption="targets" id="services" /> : null}
            {services.length || storage ? <div className="itw-service-group">
              <span className="itw-boundary-label">{services.length ? "Application services" : "Persistent storage"}</span>
              <div className="itw-bus">
                {services.map((service) => node({ aws: true, className: "is-service", detail: Number.isFinite(service.ecs?.runningCount) && Number.isFinite(service.ecs?.desiredCount) ? `${service.ecs.runningCount} of ${service.ecs.desiredCount} tasks running` : service.targets.length ? `${service.targets.filter((target) => target === "healthy").length} of ${service.targets.length} targets healthy` : updating ? "Runtime evidence pending" : "Health not observed", icon: "infrastructure", id: `svc:${service.id}`, key: service.id, name: service.name || "Application service", status: serviceStatus(service), statusLabel: serviceStatusLabel(service) }))}
              </div>
              {storage ? <div className="itw-storage">{node({ aws: true, detail: (reported(storage.status) ? label(storage.status) : null) || (storage.encrypted === true ? "Encryption enabled" : "Persistent storage reported"), icon: "storage", id: "efs", name: "Data storage", status: storage.status === "active" ? "ok" : "off" })}</div> : null}
            </div> : null}
            {hasAlbEvidence && !services.length && !storage ? <p className="itm-empty">{updating ? "Release updating — service runtime evidence pending." : "No application service evidence for this release."}</p> : null}
          </div>
        </div> : null}
        {hasEcrEvidence || taskDefinitions.length || hasCloudWatchEvidence || hasTerraformEvidence ? <div aria-label="Runtime support services" className="itw-support">
          <span className="itw-tier">Runtime dependencies</span>
          {hasEcrEvidence ? node({ aws: true, detail: evidence?.ecr?.imageDigest ? "Image digest recorded" : "Image repository recorded", icon: "code", id: "ecr", name: "Image registry", status: supportStatus(evidence?.ecr?.status) }) : null}
          {taskDefinitions.length ? node({ aws: true, detail: `${taskDefinitions.length} recorded revision${taskDefinitions.length === 1 ? "" : "s"}`, icon: "settings", id: "tasks", name: "Runtime revisions", status: "off" }) : null}
          {hasCloudWatchEvidence ? node({ aws: true, detail: evidence?.cloudWatch?.logGroupName ? "Log group observed" : identity.cloudWatchLogGroupName ? "Log group configured" : label(evidence?.cloudWatch?.status), icon: "activity", id: "cloudwatch", name: "Application logs", status: supportStatus(evidence?.cloudWatch?.status) }) : null}
          {hasTerraformEvidence ? node({ aws: true, detail: evidence?.terraformState?.key || identity.terraformStateKey ? "State identity recorded" : label(evidence?.terraformState?.status), icon: "infrastructure", id: "terraform", name: "State storage", status: supportStatus(evidence?.terraformState?.status) }) : null}
        </div> : null}
      </div>
      {inspector ? <aside aria-label="Selected resource" aria-live="polite" className={`itw-inspector is-${inspector.status}`}>
        <h3>{inspector.title}</h3>
        <span className="itw-kind">{inspector.kind}</span>
        <div className="itw-props">{inspector.rows.filter(([, item]) => reported(item)).map(([name, item]) => <div className="itw-prop" key={name}><span>{name}</span><strong>{value(item)}</strong></div>)}</div>
        <p className="itw-hint">Select any resource in the topology to inspect its recorded evidence.</p>
      </aside> : null}
    </div>
  </section>;
}

function ServiceRuntimeList({ evidence, transitioning = false }) {
  const persisted = Array.isArray(evidence?.runtimeIdentity?.services) ? evidence.runtimeIdentity.services : [];
  const observed = new Map((evidence?.services || []).map((service) => [service.serviceId, service]));
  if (!persisted.length) return null;
  return <Card className="infrastructure-runtime-card"><div className="infrastructure-section-heading"><div><p className="eyebrow">Services</p><h2>Running applications</h2></div></div><ul className="infra-service-list">{persisted.map((service) => {
    const current = observed.get(service.serviceId);
    const targets = (current?.alb?.targetHealth || []).filter(reported).map((state) => String(state).toLowerCase()).filter((state) => state !== "draining");
    const hasTaskCounts = Number.isFinite(current?.ecs?.runningCount) && Number.isFinite(current?.ecs?.desiredCount);
    const taskMismatch = hasTaskCounts && current.ecs.runningCount !== current.ecs.desiredCount;
    const targetFailure = targets.includes("unhealthy");
    const healthy = hasTaskCounts && !taskMismatch && targets.length > 0 && targets.every((state) => state === "healthy");
    const healthObserved = hasTaskCounts || targets.length > 0;
    const status = healthy ? "healthy" : transitioning && !healthObserved ? "running" : targetFailure ? "unhealthy" : taskMismatch ? "degraded" : "unknown";
    const statusLabel = healthy ? "Healthy" : transitioning && !healthObserved ? "Updating" : targetFailure ? "Unhealthy" : taskMismatch ? "Degraded" : current ? "Health not fully observed" : "Awaiting observation";
    const runtimeFacts = [
      hasTaskCounts ? `${current.ecs.runningCount} of ${current.ecs.desiredCount} tasks running` : null,
      targets.length ? `${targets.filter((target) => target === "healthy").length} of ${targets.length} targets healthy` : null,
    ].filter(Boolean);
    return <li className="infra-service-row" key={service.serviceId}>
      <div className="infra-service-main"><div><strong>{service.serviceName || "Application service"}</strong>{service.serviceDirectory ? <small>Path {service.serviceDirectory}</small> : null}</div><StatusChip status={status}>{statusLabel}</StatusChip></div>
      {service.servicePort ? <span className="infra-service-port">Port {service.servicePort}</span> : null}
      {runtimeFacts.length ? <p>{runtimeFacts.join(" · ")}</p> : null}
      {service.publicUrl ? <a href={service.publicUrl} rel="noreferrer" target="_blank">Open ↗</a> : null}
    </li>;
  })}</ul></Card>;
}

function SupportingServices({ evidence }) {
  const identity = evidence?.runtimeIdentity || {};
  const terraform = evidence?.terraformState;
  const cloudWatch = evidence?.cloudWatch;
  const services = [
    reported(terraform?.status) || terraform?.key || identity.terraformStateKey
      ? { name: "Infrastructure state", status: reported(terraform?.status) ? terraform.status : null, note: "State identity recorded" }
      : null,
    reported(cloudWatch?.status) || cloudWatch?.logGroupName || identity.cloudWatchLogGroupName
      ? { name: "Application logs", status: reported(cloudWatch?.status) ? cloudWatch.status : null, note: cloudWatch?.logGroupName ? "Log group observed" : "Log group configured" }
      : null,
  ].filter(Boolean);
  if (!services.length) return null;
  return <Card className="infrastructure-support-card"><div className="infrastructure-section-heading"><div><p className="eyebrow">Supporting services</p><h2>Runtime operations</h2></div></div><ul className="infra-support-list">{services.map(({ name, status, note }) => <li key={name}><strong>{name}</strong>{status ? <StatusChip status={status}>{label(status)}</StatusChip> : <span className="infra-evidence-note">{note}</span>}</li>)}</ul></Card>;
}

function Pricing({ cost }) {
  const available = cost?.source === "infracost" && ["estimated", "approval_required"].includes(cost?.status) && Number.isFinite(cost?.monthly);
  const unavailableReason = reported(cost?.unavailableReason) ? cost.unavailableReason : null;
  if (!available && !unavailableReason) return null;
  const breakdown = Array.isArray(cost?.breakdown) ? cost.breakdown
    .filter((item) => Number.isFinite(item?.monthly))
    .map((item) => ({ ...item, displayName: reported(item.service) ? item.service : item.name }))
    .filter((item) => reported(item.displayName)) : [];
  const maximum = Math.max(...breakdown.map((item) => Number(item.monthly)), 1);
  const currency = reported(cost?.currency) ? `${cost.currency} ` : "";
  const estimatedAt = date(cost?.estimatedAt);
  return <Card className="infrastructure-finops-card"><div className="infrastructure-section-heading"><div><p className="eyebrow">Cost</p><h2>Estimated monthly cost</h2></div>{available ? <span className="infrastructure-source">Recorded estimate</span> : null}</div>
    {available ? <><div className="infrastructure-cost-summary"><MetricCard detail={estimatedAt ? `Last calculated ${estimatedAt}` : undefined} label="Monthly estimate" value={`${currency}${Number(cost.monthly).toFixed(2)} / month`} /></div>{breakdown.length ? <details className="infrastructure-cost-details"><summary>View cost breakdown</summary><ChartCard description="Recorded service estimates." hasData title="Service breakdown"><ol className="infrastructure-cost-bars">{breakdown.map((item) => <li key={`${item.displayName}-${item.monthly}`}><span>{item.displayName}</span><strong>{currency}{Number(item.monthly).toFixed(2)}</strong><i style={{ width: `${Math.max(0, Math.min(100, (Number(item.monthly) / maximum) * 100))}%` }} /></li>)}</ol></ChartCard></details> : null}</> : <p className="infrastructure-cost-note">{unavailableReason}</p>}
  </Card>;
}

function TechnicalDetails({ state, evidence }) {
  const identity = evidence?.runtimeIdentity || {};
  const imageReference = (uri, digest) => uri && digest ? `${uri}@${digest}` : uri || digest;
  const rows = [
    ["Generation", state?.generationState?.liveGenerationId], ["Source SHA", state?.stableRelease?.commit],
    ["Image", imageReference(identity.imageUri, identity.imageDigest)],
    ["ECS cluster", identity.ecsClusterArn || identity.ecsClusterName], ["ECS service", identity.ecsServiceArn || identity.ecsServiceName],
    ["Task definition", identity.taskDefinitionArn], ["ALB", identity.albArn || identity.albName],
    ["Target group", identity.targetGroupArn || identity.targetGroupName], ["CloudWatch log group", identity.cloudWatchLogGroupName || evidence?.cloudWatch?.logGroupName],
    ["Terraform state", identity.terraformStateKey || evidence?.terraformState?.key], ["Cost estimate source", evidence?.cost?.source],
  ];
  for (const [index, service] of (Array.isArray(identity.services) ? identity.services : []).entries()) {
    const name = service.serviceName || `Application service ${index + 1}`;
    rows.push([`${name} image`, imageReference(service.imageUri, service.imageDigest)], [`${name} ECS service`, service.ecsServiceArn], [`${name} task definition`, service.taskDefinitionArn], [`${name} endpoint`, service.publicUrl], [`${name} log group`, service.cloudWatchLogGroupName]);
  }
  const availableRows = rows.filter(([, item]) => reported(item));
  if (!availableRows.length) return null;
  return <Card className="infrastructure-inventory-card"><details className="advanced-resource-details"><summary><span><span className="eyebrow">Advanced</span><strong>Technical details</strong></span><span>Expand</span></summary><DataTable caption="Current release resource identifiers" label="Technical infrastructure details"><thead><tr><th>Resource</th><th>Identifier</th></tr></thead><tbody>{availableRows.map(([name, item]) => <tr key={name}><td>{name}</td><td><CopyValue label="Copy full identifier" value={String(item)} visibleValue={shortened(item, 58)} /></td></tr>)}</tbody></DataTable></details></Card>;
}

function CleanupResourceEvidence({ evidence }) {
  const resources = Array.isArray(evidence?.resources) ? evidence.resources : [];
  const items = [
    ["Container service", resources.find((resource) => resource.type === "ECS Fargate")?.status],
    ["Load balancer", resources.find((resource) => resource.type === "ALB")?.status],
    ["Infrastructure state", evidence?.terraformState?.status],
  ].filter(([, status]) => reported(status));
  if (!items.length) return null;
  return <div className="infra-cleanup-evidence"><p className="eyebrow">Recorded cleanup state</p><ul>{items.map(([name, status]) => <li key={name}><span>{name}</span><StatusChip status={status}>{label(status)}</StatusChip></li>)}</ul></div>;
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
  if (!state) return <div className="infrastructure-page grid dg-infra dg-infra-light"><PageHeader actions={exportAction} eyebrow="Infrastructure" title="Runtime infrastructure" /><ErrorState message={error} onRetry={() => void load()} /></div>;
  if (cleanupRequired) return <div className="infrastructure-page grid"><PageHeader actions={exportAction} eyebrow="Infrastructure" title="Destroy cleanup required" status="blocked" /><Card><p className="eyebrow">Runtime is not LIVE</p><h2>Destroy failed after runtime removal or before the previous runtime could be verified.</h2><p>{state?.stateAuthority?.reason || "DeployGuard will not treat historical release evidence as current infrastructure health."}</p><CleanupResourceEvidence evidence={evidence} /><Link className="secondary-button" to={`/projects/${projectId}/pipeline`}>Retry Failed Destroy</Link></Card></div>;
  if (destroyRemoved) return <div className="infrastructure-page grid"><PageHeader actions={exportAction} eyebrow="Infrastructure" title="Runtime removed · Destroy finalizing" status="destroying" /><Card><p className="eyebrow">Authoritative runtime observation</p><h2>The application service and load balancer are removed.</h2><p>The Destroy operation remains active while DeployGuard verifies deletion and finalizes control-plane cleanup.</p><Link className="secondary-button" to={`/projects/${projectId}/pipeline`}>View Destroy progress</Link></Card></div>;
  if (absent) return <div className="infrastructure-page grid"><PageHeader actions={exportAction} eyebrow="Infrastructure" title="Runtime infrastructure" status="not_provisioned" /><Card><p className="eyebrow">Runtime infrastructure not provisioned</p><h2>Deployment stopped during {state?.progress?.phase === "build" ? "Build Application" : "source preparation"}.</h2><p>Runtime infrastructure was not provisioned. Open Pipeline for the bounded failure evidence.</p><Link className="secondary-button" to={`/projects/${projectId}/pipeline`}>Open Pipeline</Link></Card></div>;
  if (provisioningFailed) return <div className="infrastructure-page grid"><PageHeader actions={exportAction} eyebrow="Infrastructure" title="Runtime infrastructure" status="provisioning_failed" /><Card><p className="eyebrow">Provisioning failed</p><h2>Runtime provisioning did not complete.</h2><p>Some resources may exist. Open Pipeline for bounded infrastructure evidence.</p><Link className="secondary-button" to={`/projects/${projectId}/pipeline`}>Open Pipeline</Link></Card></div>;
  const runtimePresent = state?.stateAuthority?.runtime?.state === "present";
  const releaseUpdating = Boolean(state?.stateAuthority?.activeOperation && state.stateAuthority.activeOperation.type !== "destroy");
  const runtimeTitle = runtimePresent ? (state?.stateAuthority?.state === "DESTROYING" ? "Runtime present · Destroy in progress" : failedDestroy ? "Runtime present · Latest Destroy failed" : "Runtime service architecture") : "Runtime infrastructure state";
  const observedServices = Array.isArray(evidence?.services) ? evidence.services : [];
  const servicesWithTaskEvidence = observedServices.filter((service) => Number.isFinite(service?.ecs?.runningCount) && Number.isFinite(service?.ecs?.desiredCount));
  const servicesAtDesiredCount = servicesWithTaskEvidence.filter((service) => service.ecs.runningCount === service.ecs.desiredCount).length;
  const allObservedServicesHealthy = observedServices.length > 0 && observedServices.every((service) => {
    const targets = (service?.alb?.targetHealth || []).filter(reported).map((target) => String(target).toLowerCase()).filter((target) => target !== "draining");
    return Number.isFinite(service?.ecs?.runningCount) && Number.isFinite(service?.ecs?.desiredCount)
      && service.ecs.runningCount === service.ecs.desiredCount && targets.length > 0 && targets.every((target) => target === "healthy");
  });
  const targetHealth = observedServices.length
    ? observedServices.flatMap((service) => service?.alb?.targetHealth || [])
    : evidence?.alb?.targetHealth || [];
  const recordedTargetHealth = targetHealth.filter(reported).map((target) => String(target).toLowerCase());
  const activeTargetHealth = recordedTargetHealth.filter((target) => target !== "draining");
  const drainingTargets = recordedTargetHealth.filter((target) => target === "draining").length;
  const healthyTargets = activeTargetHealth.filter((target) => target === "healthy").length;
  const targetsHealthy = activeTargetHealth.length > 0 && healthyTargets === activeTargetHealth.length;
  const identityServices = Array.isArray(evidence?.runtimeIdentity?.services) ? evidence.runtimeIdentity.services : [];
  const hasRegionEvidence = Boolean(evidence?.runtimeIdentity?.region || evidence?.ecr || evidence?.ecs || evidence?.alb || observedServices.length);
  const observedRegion = hasRegionEvidence && reported(evidence?.region) ? evidence.region : null;
  const hasUnhealthyTargets = activeTargetHealth.includes("unhealthy");
  const legacyTaskCountsAvailable = Number.isFinite(evidence?.ecs?.runningCount) && Number.isFinite(evidence?.ecs?.desiredCount);
  const serviceMetric = observedServices.length
    ? { label: "Services", value: servicesWithTaskEvidence.length === observedServices.length && servicesWithTaskEvidence.length ? `${servicesAtDesiredCount}/${observedServices.length} at desired task count` : `${observedServices.length} observed`, tone: allObservedServicesHealthy ? "success" : "neutral" }
    : legacyTaskCountsAvailable
      ? { label: "Running tasks", value: `${evidence.ecs.runningCount} of ${evidence.ecs.desiredCount}`, tone: "neutral" }
      : releaseUpdating && identityServices.length
        ? { label: "Services", value: "Release updating", tone: "neutral" }
        : null;
  const applicationState = state?.stateAuthority?.runtime?.state;
  const summaryItems = [
    runtimePresent ? { label: "Application", value: state?.stableUrl ? <a href={state.stableUrl} rel="noreferrer" target="_blank">Open application ↗</a> : "Runtime present", tone: "neutral" } : applicationState ? { label: "Application", value: label(applicationState), tone: "neutral" } : null,
    serviceMetric,
    activeTargetHealth.length ? { label: "Targets", value: `${healthyTargets}/${activeTargetHealth.length} healthy${drainingTargets ? ` · ${drainingTargets} draining` : ""}`, tone: targetsHealthy ? "success" : hasUnhealthyTargets ? "danger" : "neutral" } : null,
    observedRegion ? { label: "Region", value: observedRegion, tone: "neutral" } : null,
  ].filter(Boolean);
  return <div className="infrastructure-page grid dg-infra dg-infra-light"><PageHeader actions={exportAction} title={releaseUpdating ? "Runtime release updating" : runtimeTitle} status={reported(infrastructure?.status) ? infrastructure.status : undefined} description={releaseUpdating ? "The previous live release remains available while the new release starts." : "Current architecture and recorded runtime evidence for this release."} />{error ? <ErrorState message={error} onRetry={() => void load()} /> : null}
    <TopologyMap evidence={evidence} state={state} updating={releaseUpdating} />
    {summaryItems.length ? <section aria-label="Infrastructure summary" className="infrastructure-summary-grid">{summaryItems.map((item) => <MetricCard key={item.label} label={item.label} tone={item.tone} value={item.value} />)}</section> : null}
    <div className="infra-columns"><div className="infra-column-main"><ServiceRuntimeList evidence={evidence} transitioning={releaseUpdating} /></div><div className="infra-column-side"><Pricing cost={evidence?.cost} /><SupportingServices evidence={evidence} /></div></div>
    <TechnicalDetails evidence={evidence} state={state} /></div>;
}
