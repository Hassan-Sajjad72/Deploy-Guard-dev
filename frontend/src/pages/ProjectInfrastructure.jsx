import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { createTerraformExport, downloadTerraformExport } from "../api/platformApi.js";
import { getProjectDetailedCurrentState } from "../api/projectApi.js";
import AppIcon from "../components/common/AppIcon.jsx";
import { Badge, Button, Callout, CopyValue, DataTable, Disclosure, EmptyState, PageHeader, Section } from "../components/common/DesignSystem.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import Time from "../components/common/Time.jsx";
import { useToast } from "../hooks/useToast.js";
import { redirectDeletedProject, subscribeProjectStateChanged } from "../utils/projectStateSync.js";
import { projectStatePresentation } from "../utils/projectStatePresentation.js";

function label(value) {
  return value ? String(value).replaceAll("_", " ").replaceAll("-", " ").toLowerCase().replace(/^\w/, (letter) => letter.toUpperCase()) : "—";
}

function shortened(value, max = 34) {
  if (!value) return "—";
  const text = String(value);
  return text.length > max ? `${text.slice(0, max - 10)}…${text.slice(-8)}` : text;
}

function money(amount, currency = "USD") {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD" }).format(Number(amount));
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
  return <Button aria-busy={exporting || undefined} disabled={exporting} icon="code" onClick={exportTerraform}>{exporting ? "Preparing export…" : "Export Terraform"}</Button>;
}

function hostOf(url) {
  try { return url ? new URL(url).host : null; } catch { return null; }
}

const HEALTH_TEXT = { ok: "Healthy", warn: "Updating", bad: "Needs attention", off: "No evidence" };

function TopologyNode({ id, icon, name, detail, status = "off", aws = false, selected, onSelect }) {
  return <button aria-pressed={selected === id} className={`topo-node is-${status}${aws ? " is-aws" : ""}`} data-node={id} onClick={() => onSelect(id)} type="button">
    <span aria-hidden="true" className="topo-icon"><AppIcon name={icon} size={17} /></span>
    <span className="topo-copy"><strong>{name}</strong><small>{detail}</small></span>
    {status !== "off" ? <span className="topo-dot" role="img" aria-label={HEALTH_TEXT[status]} /> : null}
  </button>;
}

/**
 * Deployed topology drawn only from canonical infrastructure evidence.
 * Resources without evidence (subnets, DNS provider, database) are not
 * invented. Selecting a resource opens its recorded evidence in the inspector.
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
  const [selected, setSelected] = useState(services[0] ? `svc:${services[0].id}` : allTargets.length ? "alb" : "endpoint");

  const selectedService = selected.startsWith("svc:") ? services.find((service) => `svc:${service.id}` === selected) : null;
  const inspector = selectedService ? {
    title: selectedService.name || "Service", kind: "Container service · ECS Fargate", status: statusFor(serviceHealthy(selectedService)),
    rows: [["Running", selectedService.ecs ? `${selectedService.ecs.runningCount} of ${selectedService.ecs.desiredCount} tasks` : null], ["Starting", selectedService.ecs?.pendingCount ? `${selectedService.ecs.pendingCount} tasks` : null], ["Load balancer checks", selectedService.targets.length ? `${selectedService.targets.filter((target) => target === "healthy").length} of ${selectedService.targets.length} healthy` : "Not routed through the load balancer"], ["Port", selectedService.port], ["Directory", selectedService.directory], ["Public URL", selectedService.publicUrl], ["ECS service", selectedService.ecs?.service ? <span className="mono">{selectedService.ecs.service}</span> : null], ["Image", selectedService.imageDigest ? <span className="mono" title={selectedService.imageDigest}>{shortened(selectedService.imageDigest, 30)}</span> : null]],
  } : {
    endpoint: { title: "Public URL", kind: "Where users reach your app", status: host ? "ok" : "off", rows: [["Host", host], ["URL", state?.stableUrl]] },
    alb: { title: "Load balancer", kind: "AWS Application Load Balancer", status: allTargets.length ? statusFor(albHealthy) : "off", rows: [["Health checks", allTargets.length ? `${healthyTargets} of ${allTargets.length} healthy` : updating ? "Release updating" : null], ["Status", evidence?.alb?.status ? label(evidence.alb.status) : null], ["Name", evidence?.alb?.name || identity.albName ? <span className="mono">{evidence?.alb?.name || identity.albName}</span> : null], ["Target group", identity.targetGroupName ? <span className="mono">{identity.targetGroupName}</span> : null], ["Region", evidence?.region]] },
    efs: { title: "Persistent storage", kind: "AWS Elastic File System", status: storage?.status === "active" ? "ok" : "off", rows: [["Status", storage ? label(storage.status) : null], ["Encrypted", storage ? (storage.encrypted ? "Yes" : "No") : null], ["Backups", storage ? (storage.backupEnabled ? "On" : "Off") : null], ["Region", storage?.region]] },
    ecr: { title: "Image registry", kind: "Amazon ECR", status: evidence?.ecr?.imageDigest ? "ok" : "off", rows: [["Repository", evidence?.ecr?.repository ? <span className="mono">{evidence.ecr.repository}</span> : null], ["Tag", evidence?.ecr?.imageTag ? <span className="mono">{evidence.ecr.imageTag}</span> : null], ["Digest", evidence?.ecr?.imageDigest ? <span className="mono" title={evidence.ecr.imageDigest}>{shortened(evidence.ecr.imageDigest, 30)}</span> : null]] },
    cloudwatch: { title: "Logs and metrics", kind: "Amazon CloudWatch", status: evidence?.cloudWatch?.status === "active" ? "ok" : "off", rows: [["Status", label(evidence?.cloudWatch?.status)], ["Log group", identity.cloudWatchLogGroupName ? <span className="mono">{identity.cloudWatchLogGroupName}</span> : null]] },
    terraform: { title: "Infrastructure state", kind: "Terraform state", status: evidence?.terraformState?.status === "active" ? "ok" : "off", rows: [["Status", label(evidence?.terraformState?.status)], ["Storage", evidence?.terraformState?.storage === "encrypted_s3" ? "Encrypted S3" : evidence?.terraformState?.storage], ["Last applied", evidence?.terraformState?.lastApplyAt ? <Time value={evidence.terraformState.lastApplyAt} /> : null], ["State key", evidence?.terraformState?.key ? <span className="mono" title={evidence.terraformState.key}>{shortened(evidence.terraformState.key, 34)}</span> : null]] },
  }[selected] || null;
  const node = ({ key, ...props }) => <TopologyNode key={key} onSelect={setSelected} selected={selected} {...props} />;
  const rows = inspector?.rows.filter(([, item]) => item !== null && item !== undefined && item !== "") || [];

  return <section aria-labelledby="topo-title" className="topo">
    <h2 className="sr-only" id="topo-title">How your app is connected</h2>
    <div className="topo-canvas">
      <div className="topo-edge">
        {node({ id: "endpoint", detail: host ? host.split(".").flatMap((part, index) => index ? [".", <wbr key={index} />, part] : [part]) : "No verified URL", icon: "globe", name: "Public URL", status: host ? "ok" : "off" })}
      </div>
      <span aria-hidden="true" className="topo-link" />
      <div className="topo-aws">
        <span className="topo-boundary">AWS · {evidence?.region || "region unknown"}</span>
        {node({ aws: true, detail: allTargets.length ? `${healthyTargets}/${allTargets.length} health checks passing` : updating ? "Release updating" : "No health-check evidence", icon: "branch", id: "alb", name: "Load balancer", status: allTargets.length ? statusFor(albHealthy) : "off" })}
        <span aria-hidden="true" className="topo-link is-vertical" />
        <div className="topo-services">
          <span className="topo-boundary is-inner">Services</span>
          {services.map((service) => node({ aws: true, detail: `${service.ecs ? `${service.ecs.runningCount}/${service.ecs.desiredCount} running` : "No task evidence"}${service.port ? ` · port ${service.port}` : ""}`, icon: "server", id: `svc:${service.id}`, key: service.id, name: service.name || "Service", status: statusFor(serviceHealthy(service)) }))}
          {!services.length ? <p className="muted topo-empty">{updating ? "Release updating — service evidence pending." : "No service evidence for this release."}</p> : null}
          {storage ? node({ aws: true, detail: `${label(storage.status)}${storage.encrypted ? " · encrypted" : ""}${storage.backupEnabled ? " · backed up" : ""}`, icon: "storage", id: "efs", name: "Persistent storage", status: storage.status === "active" ? "ok" : "off" }) : null}
        </div>
        <div className="topo-support" aria-label="Supporting resources">
          {node({ aws: true, detail: evidence?.ecr?.imageDigest ? "Image published" : "No image evidence", icon: "box", id: "ecr", name: "Image registry", status: evidence?.ecr?.imageDigest ? "ok" : "off" })}
          {node({ aws: true, detail: evidence?.cloudWatch?.status === "active" ? "Collecting" : label(evidence?.cloudWatch?.status), icon: "logs", id: "cloudwatch", name: "Logs and metrics", status: evidence?.cloudWatch?.status === "active" ? "ok" : "off" })}
          {node({ detail: evidence?.terraformState?.status === "active" ? "Stored, encrypted" : label(evidence?.terraformState?.status), icon: "state", id: "terraform", name: "Infrastructure state", status: evidence?.terraformState?.status === "active" ? "ok" : "off" })}
        </div>
      </div>
    </div>
    {inspector ? <aside aria-label="Selected resource" aria-live="polite" className="topo-inspector">
      <div className="topo-inspector-head"><h3>{inspector.title}</h3><span className="muted">{inspector.kind}</span></div>
      {inspector.status !== "off" ? <span className={`status tone-${inspector.status === "ok" ? "ok" : inspector.status === "warn" ? "warn" : "bad"}`}>{HEALTH_TEXT[inspector.status]}</span> : <span className="status tone-neutral">No live evidence</span>}
      {rows.length ? <dl className="facts-list">{rows.map(([name, item]) => <div key={name}><dt>{name}</dt><dd>{item}</dd></div>)}</dl> : <p className="muted">Nothing has been recorded for this resource yet.</p>}
      <p className="muted topo-hint">Select any resource to see what DeployGuard recorded for it.</p>
    </aside> : null}
  </section>;
}

function CostEstimate({ cost }) {
  const available = cost?.source === "infracost" && ["estimated", "approval_required"].includes(cost?.status) && Number.isFinite(cost?.monthly);
  const breakdown = Array.isArray(cost?.breakdown) ? cost.breakdown.filter((item) => Number.isFinite(item?.monthly)) : [];
  const maximum = Math.max(...breakdown.map((item) => Number(item.monthly)), 1);
  return <Section id="infra-cost" title="Estimated cost">
    {available ? <div className="panel panel-pad cost">
      <div className="cost-total"><strong className="num">{money(cost.monthly, cost.currency)}</strong><span className="muted"> per month</span>{cost.status === "approval_required" ? <Badge tone="warning">Needs approval</Badge> : null}</div>
      <p className="muted cost-note">Estimated by Infracost for the current release{cost.estimatedAt ? <>, <Time value={cost.estimatedAt} /></> : null}. Your AWS bill is the final figure.</p>
      {breakdown.length ? <ol className="cost-bars">{breakdown.map((item) => <li key={`${item.name}-${item.monthly}`}><span>{item.name}</span><span className="cost-bar" aria-hidden="true"><i style={{ width: `${Math.max(2, (Number(item.monthly) / maximum) * 100)}%` }} /></span><strong className="num">{money(item.monthly, cost.currency)}</strong></li>)}</ol> : null}
    </div> : <p className="muted">{cost?.unavailableReason || "No cost estimate exists for the current release."}</p>}
  </Section>;
}

function ResourceIdentifiers({ state, evidence }) {
  const identity = evidence?.runtimeIdentity || {};
  const rows = [
    ["Generation", state?.generationState?.liveGenerationId], ["Source commit", state?.stableRelease?.commit],
    ["Image", identity.imageDigest ? `${identity.imageUri}@${identity.imageDigest}` : identity.imageUri],
    ["ECS cluster", identity.ecsClusterArn || identity.ecsClusterName], ["ECS service", identity.ecsServiceArn || identity.ecsServiceName],
    ["Task definition", identity.taskDefinitionArn], ["Load balancer", identity.albArn || identity.albName],
    ["Target group", identity.targetGroupArn || identity.targetGroupName], ["Log group", identity.cloudWatchLogGroupName],
    ["Terraform state", identity.terraformStateKey || evidence?.terraformState?.key],
  ];
  for (const service of Array.isArray(identity.services) ? identity.services : []) {
    rows.push([`${service.serviceName} · image`, service.imageDigest ? `${service.imageUri}@${service.imageDigest}` : service.imageUri], [`${service.serviceName} · ECS service`, service.ecsServiceArn], [`${service.serviceName} · task definition`, service.taskDefinitionArn], [`${service.serviceName} · URL`, service.publicUrl], [`${service.serviceName} · log group`, service.cloudWatchLogGroupName]);
  }
  const present = rows.filter(([, value]) => value);
  if (!present.length) return null;
  return <Disclosure meta={`${present.length} identifiers`} summary="AWS resource identifiers">
    <DataTable caption="Exact identifiers of the current release's resources" label="AWS resource identifiers" stack={false}><thead><tr><th>Resource</th><th>Identifier</th></tr></thead><tbody>{present.map(([name, value]) => <tr key={name}><td className="nowrap">{name}</td><td><CopyValue value={String(value)} visibleValue={shortened(value, 72)} /></td></tr>)}</tbody></DataTable>
  </Disclosure>;
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
  if (!state && !error) return <LoadingState message="Loading infrastructure…" />;
  const infrastructure = state?.stateAuthority?.infrastructure;
  const evidence = state?.infrastructureEvidence;
  const failedDestroy = state?.stateAuthority?.latestCompletedOperation?.type === "destroy"
    && state?.stateAuthority?.latestCompletedOperation?.outcome === "failed";
  const cleanupRequired = failedDestroy && state?.stateAuthority?.state === "BLOCKED";
  const absent = infrastructure?.exists === false || infrastructure?.status === "not_provisioned";
  const provisioningFailed = infrastructure?.status === "provisioning_failed";
  const destroyRemoved = state?.stateAuthority?.activeOperation?.type === "destroy" && state?.stateAuthority?.runtime?.state === "removed";
  const runtimePresent = state?.stateAuthority?.runtime?.state === "present";
  const releaseUpdating = Boolean(state?.stateAuthority?.activeOperation && state.stateAuthority.activeOperation.type !== "destroy");
  const header = <PageHeader actions={state && !absent ? <TerraformExportAction projectId={projectId} /> : null} description="What runs your app on AWS, how it is connected, and what it costs." title="Infrastructure" />;

  if (!state) return <div className="page">{header}<ErrorState message={error} onRetry={load} title="Infrastructure could not be loaded" /></div>;
  if (cleanupRequired) return <div className="page infrastructure-page">{header}<Callout actions={<Button to={`/projects/${projectId}`}>Go to overview to retry</Button>} title="Destroy did not finish" tone="danger"><p>{state?.stateAuthority?.reason || "Some resources may still exist. The runtime is not live and old release evidence is not treated as current."}</p><dl className="facts infra-cleanup-facts"><div><dt>Containers</dt><dd>{label(evidence?.resources?.find((resource) => resource.type === "ECS Fargate")?.status)}</dd></div><div><dt>Load balancer</dt><dd>{label(evidence?.resources?.find((resource) => resource.type === "ALB")?.status)}</dd></div><div><dt>Infrastructure state</dt><dd>{label(evidence?.terraformState?.status)}</dd></div></dl></Callout></div>;
  if (destroyRemoved) return <div className="page infrastructure-page">{header}<Callout actions={<Button to={`/projects/${projectId}/pipeline`}>Follow progress</Button>} title="Resources removed — finishing up" tone="info"><p>The app's containers and load-balancer routing are gone. DeployGuard is verifying deletion and finishing cleanup.</p></Callout></div>;
  if (absent) return <div className="page infrastructure-page">{header}<EmptyState action={<Button to={`/projects/${projectId}${state?.stateAuthority?.state === "FAILED" ? "/troubleshooting" : ""}`}>{state?.stateAuthority?.state === "FAILED" ? "See what went wrong" : "Go to overview"}</Button>} icon="infrastructure" message={state?.stateAuthority?.state === "FAILED" ? `The deployment stopped during ${state?.progress?.phase === "build" ? "the build" : "source preparation"}, before any AWS resources were created.` : state?.stateAuthority?.state === "DESTROYED" ? "This project's AWS resources were destroyed. Deploy again to recreate them." : "Nothing has been created on AWS yet. Infrastructure appears here after the first deployment."} title="No infrastructure" /></div>;
  if (provisioningFailed) return <div className="page infrastructure-page">{header}<Callout actions={<Button to={`/projects/${projectId}/troubleshooting`}>See what went wrong</Button>} title="Provisioning did not complete" tone="danger"><p>Some AWS resources may exist. Troubleshoot shows the recorded infrastructure evidence.</p></Callout></div>;
  return <div className="page infrastructure-page">
    {header}
    {error ? <ErrorState message={error} onRetry={() => void load()} title="Showing the last loaded state" /> : null}
    {releaseUpdating ? <Callout title="A new release is rolling out" tone="info"><p>The current live release keeps serving until the new one passes its health check.</p></Callout> : null}
    {failedDestroy && runtimePresent ? <Callout title="The latest destroy failed" tone="warning"><p>Your app is still running. Retry the destroy from the overview when ready.</p></Callout> : null}
    <TopologyMap evidence={evidence} state={state} updating={releaseUpdating} />
    <CostEstimate cost={evidence?.cost} />
    <ResourceIdentifiers evidence={evidence} state={state} />
  </div>;
}
