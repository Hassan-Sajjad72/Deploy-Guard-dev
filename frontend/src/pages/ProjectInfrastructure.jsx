import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { createTerraformExport, downloadTerraformExport } from "../api/platformApi.js";
import { getProject, getProjectCurrentState } from "../api/projectApi.js";
import {
  Button,
  Card,
  ChartCard,
  CopyValue,
  DataTable,
  EmptyState,
  MetricCard,
  PageHeader,
  StatusChip,
} from "../components/common/DesignSystem.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { projectStatePresentation } from "../utils/projectStatePresentation.js";
import { subscribeProjectStateChanged } from "../utils/projectStateSync.js";

function date(value) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Unavailable";
}

function label(value) {
  return value ? String(value).replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Unavailable";
}

function shortened(value, max = 28) {
  if (!value) return "Unavailable";
  const text = String(value);
  return text.length > max ? `${text.slice(0, Math.max(10, max - 9))}…${text.slice(-8)}` : text;
}

function resourceStatus(evidence, available) {
  if (evidence?.terraformState?.status === "destroyed") return "historical";
  return available ? "active" : "unavailable";
}

function topologyStatus(evidence, available) {
  const status = resourceStatus(evidence, available);
  return status === "historical" ? "historical" : status === "active" ? "active" : "unavailable";
}

function sourceLabel(source) {
  return source === "github_actions" ? "GitHub Actions and AWS" : source === "infrastructure_record" ? "Recorded infrastructure evidence" : "Unavailable";
}

function ResourceIdentifier({ value }) {
  return value ? <CopyValue label="Copy full identifier" value={value} visibleValue={shortened(value)} /> : <span className="muted">Unavailable</span>;
}

function ResourceInventory({ evidence }) {
  const historical = evidence?.terraformState?.status === "destroyed";
  const ecrStatus = resourceStatus(evidence, Boolean(evidence?.ecr));
  const ecsStatus = resourceStatus(evidence, Boolean(evidence?.ecs));
  const albStatus = resourceStatus(evidence, Boolean(evidence?.alb));
  const stateStatus = evidence?.terraformState?.status || "unavailable";
  return <Card className="infrastructure-inventory-card">
    <div className="infrastructure-section-heading">
      <div><p className="eyebrow">Resource inventory</p><h2>{historical ? "Last known infrastructure" : "Current AWS resources"}</h2><p>{historical ? "These identifiers are retained as historical GitHub Actions evidence. No live endpoint or active resource is claimed." : "Read-only AWS evidence is refreshed from the canonical GitHub Actions deployment state."}</p></div>
      <span className="infrastructure-source">Source: {sourceLabel(evidence?.source)}</span>
    </div>
    <DataTable caption={historical ? "Historical infrastructure inventory" : "Current infrastructure inventory"} className="responsive-record-table" label="Infrastructure resource inventory">
      <thead><tr><th>Resource</th><th>Identifier</th><th>Status</th><th>Details</th></tr></thead>
      <tbody>
        <tr><td data-label="Resource">ECR repository</td><td data-label="Identifier"><ResourceIdentifier value={evidence?.ecr?.repository} /></td><td data-label="Status"><StatusChip status={ecrStatus}>{historical ? "Historical" : label(ecrStatus)}</StatusChip></td><td data-label="Details">{evidence?.ecr?.imageTag ? <>Latest image <span title={evidence.ecr.imageTag}>{shortened(evidence.ecr.imageTag, 24)}</span></> : historical ? "Last known repository retained; image evidence is unavailable." : "Latest image evidence unavailable."}</td></tr>
        <tr><td data-label="Resource">ECS service</td><td data-label="Identifier"><ResourceIdentifier value={evidence?.ecs?.service} /></td><td data-label="Status"><StatusChip status={ecsStatus}>{historical ? "Historical" : label(ecsStatus)}</StatusChip></td><td data-label="Details">{evidence?.ecs ? `${evidence.ecs.runningCount} running / ${evidence.ecs.desiredCount} desired / ${evidence.ecs.pendingCount} pending` : historical ? "Last known service retained; task evidence is unavailable." : "Task evidence unavailable."}</td></tr>
        <tr><td data-label="Resource">Application Load Balancer</td><td data-label="Identifier"><ResourceIdentifier value={evidence?.alb?.name} /></td><td data-label="Status"><StatusChip status={albStatus}>{historical ? "Historical" : label(evidence?.alb?.status || albStatus)}</StatusChip></td><td data-label="Details">{evidence?.alb?.targetHealth?.length ? `Target health: ${evidence.alb.targetHealth.map(label).join(", ")}` : historical ? "Last known load balancer retained; target health is unavailable." : "Target health unavailable."}</td></tr>
        <tr><td data-label="Resource">Terraform state</td><td data-label="Identifier"><ResourceIdentifier value={evidence?.terraformState?.key} /></td><td data-label="Status"><StatusChip status={stateStatus}>{historical ? "Historical" : label(stateStatus)}</StatusChip></td><td data-label="Details">{evidence?.terraformState?.storage === "encrypted_s3" ? <>Encrypted S3 · {historical ? `Last destroy ${date(evidence.terraformState.lastDestroyAt)}` : `Last apply ${date(evidence.terraformState.lastApplyAt)}`}</> : "Remote-state storage is unavailable."}</td></tr>
      </tbody>
    </DataTable>
  </Card>;
}

function InfrastructureTopology({ evidence }) {
  const historical = evidence?.terraformState?.status === "destroyed";
  const nodes = [
    ["GitHub Actions", evidence?.source === "github_actions"],
    ["ECR", Boolean(evidence?.ecr)],
    ["ECS Fargate", Boolean(evidence?.ecs)],
    ["Application Load Balancer", Boolean(evidence?.alb)],
    ["Application", Boolean(evidence?.alb?.endpoint)],
  ];
  return <Card className="infrastructure-topology-card">
    <div className="infrastructure-section-heading"><div><p className="eyebrow">Deployment topology</p><h2>Release path</h2><p>{historical ? "Historical path from the completed destroy operation." : "Current path assembled only from the canonical workflow and AWS evidence."}</p></div></div>
    <ol aria-label="Infrastructure deployment topology" className="infrastructure-topology">
      {nodes.map(([name, available]) => <li data-status={topologyStatus(evidence, available)} key={name}><strong>{name}</strong><StatusChip status={topologyStatus(evidence, available)}>{historical ? "Historical" : label(topologyStatus(evidence, available))}</StatusChip></li>)}
    </ol>
    {evidence?.alb?.endpoint && !historical ? <p className="infrastructure-endpoint">Application endpoint: <a href={evidence.alb.endpoint} rel="noreferrer" target="_blank">Open verified application</a></p> : null}
  </Card>;
}

function FinOps({ cost, evidence }) {
  const verified = cost?.status === "estimated" && cost?.source === "infracost" && Number.isFinite(cost?.monthly);
  const breakdown = Array.isArray(cost?.breakdown) ? cost.breakdown.filter((item) => Number.isFinite(item?.monthly)) : [];
  return <Card className="infrastructure-finops-card">
    <div className="infrastructure-section-heading"><div><p className="eyebrow">FinOps</p><h2>Deployment cost</h2><p>Cost evidence is shown only when a verified Infracost result is attached to this release.</p></div><span className="infrastructure-source">Source: {verified ? "Infracost" : "Unavailable"}</span></div>
    {verified ? <>
      <div className="infrastructure-cost-summary"><MetricCard detail={`Calculated ${date(cost.estimatedAt || evidence?.lastUpdatedAt)}`} label="Estimated monthly cost" value={`${cost.currency || "USD"} ${Number(cost.monthly).toFixed(2)}/month`} /><MetricCard detail="Verified estimate source" label="Cost source" value="Infracost" /><MetricCard detail={`Release ${shortened(cost.releaseId, 20)}`} label="LIVE generation" value={shortened(cost.generationId, 20)} /></div>
      <ChartCard description="Service costs from the verified Infracost breakdown." hasData={breakdown.length > 0} emptyMessage="No verified service breakdown is available for this estimate." title="Estimated monthly cost by service">
        <ol aria-label="Infracost service breakdown" className="infrastructure-cost-bars">{breakdown.map((item) => <li key={`${item.service || item.name}-${item.monthly}`}><span>{item.service || item.name}</span><strong>{cost.currency || "USD"} {item.monthly}/month</strong><i style={{ width: `${Math.max(2, Math.round((item.monthly / Math.max(...breakdown.map((entry) => entry.monthly))) * 100))}%` }} /></li>)}</ol>
      </ChartCard>
      <p className="muted">Operation {shortened(cost.operationId, 24)} · Release {shortened(cost.releaseId, 24)} · Generation {shortened(cost.generationId, 24)}</p>
    </> : <EmptyState icon="activity" message={cost?.unavailableReason || "No verified Infracost estimate exists for the authoritative LIVE release."} title="Cost estimate unavailable" />}
  </Card>;
}

export default function ProjectInfrastructure() {
  const { projectId } = useParams();
  const [project, setProject] = useState(null);
  const [currentState, setCurrentState] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [exportBusy, setExportBusy] = useState(false);
  async function load() {
    try {
      const [projectResponse, state] = await Promise.all([getProject(projectId), getProjectCurrentState(projectId)]);
      setProject(projectResponse.project);
      setCurrentState(state);
      setError("");
    } catch (caught) { setError(caught.message); } finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [projectId]);
  useEffect(() => subscribeProjectStateChanged(projectId, load), [projectId]);
  async function exportTerraform() { setExportBusy(true); setError(""); try { const artifact = await createTerraformExport(projectId); await downloadTerraformExport(projectId, artifact); } catch (caught) { setError(caught.message); } finally { setExportBusy(false); } }
  if (loading) return <LoadingState message="Loading infrastructure evidence…" />;
  if (error && !currentState) return <ErrorState message={error} onRetry={load} />;
  const authority = currentState?.stateAuthority;
  const presentation = projectStatePresentation(currentState);
  const evidence = currentState?.infrastructureEvidence;
  const historical = evidence?.terraformState?.status === "destroyed";
  const taskValue = evidence?.ecs ? `${evidence.ecs.runningCount}/${evidence.ecs.desiredCount}` : historical ? "Historical" : "Unavailable";
  const albValue = evidence?.alb?.targetHealth?.length ? evidence.alb.targetHealth.map(label).join(", ") : historical ? "Historical" : "Unavailable";
  const failedDestroyWithLiveRelease = authority?.latestCompletedOperation?.outcome === "failed"
    && authority.latestCompletedOperation.type === "destroy"
    && authority?.infrastructure?.status === "active";
  return <div className="infrastructure-page grid" data-authoritative-state={presentation.state} data-infrastructure-source={evidence?.source || "unavailable"}>
    <PageHeader context={`Source: ${sourceLabel(evidence?.source)} · Last updated: ${date(evidence?.lastUpdatedAt)} · ${label(evidence?.freshness)}`} description="Verified AWS resources, Terraform portability, and release-specific cost evidence from the canonical GitHub Actions lifecycle." eyebrow="Infrastructure & FinOps" status={historical ? "historical" : authority?.infrastructure?.status || "unknown"} title={historical ? "Historical infrastructure" : "AWS infrastructure"} />
    {error ? <ErrorState message={error} onRetry={load} /> : null}
    {failedDestroyWithLiveRelease ? <Card><p className="eyebrow">Destroy did not complete</p><h2>The previous verified release is still live</h2><p>{currentState.developerMessage || "The latest Destroy failed. Review its pipeline evidence before retrying."}</p></Card> : null}
    <section aria-label="Infrastructure summary" className="infrastructure-summary-grid">
      <MetricCard detail={historical ? "Last known after the destroy operation" : `Source: ${sourceLabel(evidence?.source)}`} label="Infrastructure state" tone={historical ? "neutral" : authority?.infrastructure?.status === "active" ? "success" : "warning"} value={historical ? "Historical" : label(authority?.infrastructure?.status)} />
      <MetricCard detail="AWS deployment configuration" label="AWS region" value={evidence?.region || "Unavailable"} />
      <MetricCard detail={evidence?.ecs ? `${evidence.ecs.pendingCount} pending task${evidence.ecs.pendingCount === 1 ? "" : "s"}` : "No current ECS task evidence"} label="ECS task state" tone={evidence?.ecs?.runningCount ? "success" : "neutral"} value={taskValue} />
      <MetricCard detail={evidence?.alb?.targetHealth?.length ? "Live AWS target-health evidence" : "No current load-balancer evidence"} label="ALB health" tone={evidence?.alb?.targetHealth?.includes("healthy") ? "success" : "neutral"} value={albValue} />
    </section>
    <ResourceInventory evidence={evidence} />
    <InfrastructureTopology evidence={evidence} />
    <FinOps cost={evidence?.cost} evidence={evidence} />
    <Card className="infrastructure-export-card"><div><p className="eyebrow">Terraform portability</p><h2>Export Terraform ZIP</h2><p>Download a short-lived sanitized configuration bundle. Terraform state, plans, credentials, and real tfvars values are excluded.</p></div>{project?.canManage ? <Button disabled={exportBusy} onClick={() => void exportTerraform()} tone="secondary">{exportBusy ? "Preparing export…" : "Export Terraform ZIP"}</Button> : <p className="muted">Only the project owner can create an export.</p>}</Card>
  </div>;
}
