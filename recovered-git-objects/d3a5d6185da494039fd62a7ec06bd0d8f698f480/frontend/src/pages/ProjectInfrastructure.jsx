import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { createTerraformExport, downloadTerraformExport } from "../api/platformApi.js";
import { getProject, getProjectCurrentState } from "../api/projectApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { PageHeader } from "../components/common/Premium.jsx";
import { projectStatePresentation } from "../utils/projectStatePresentation.js";

function date(value) { return value ? new Date(value).toLocaleString() : "Unavailable"; }

export default function ProjectInfrastructure() {
  const { projectId } = useParams();
  const [project, setProject] = useState(null);
  const [currentState, setCurrentState] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [exportBusy, setExportBusy] = useState(false);
  useEffect(() => { Promise.all([getProject(projectId), getProjectCurrentState(projectId)]).then(([p, state]) => { setProject(p.project); setCurrentState(state); }).catch((caught) => setError(caught.message)).finally(() => setLoading(false)); }, [projectId]);
  async function exportTerraform() { setExportBusy(true); setError(""); try { const artifact = await createTerraformExport(projectId); await downloadTerraformExport(projectId, artifact); } catch (caught) { setError(caught.message); } finally { setExportBusy(false); } }
  if (loading) return <LoadingState message="Loading infrastructure evidence…" />;
  if (error && !currentState) return <ErrorState message={error} />;
  const authority = currentState?.stateAuthority;
  const evidence = currentState?.infrastructureEvidence;
  const presentation = projectStatePresentation(currentState);
  const cost = evidence?.cost;
  return <div className="grid" data-authoritative-state={presentation.state} data-infrastructure-source={evidence?.source || "unavailable"}>
    <PageHeader eyebrow="Infrastructure" title="AWS & Terraform evidence" description="Verified deployment resources and portable Terraform configuration from the canonical GitHub Actions lifecycle." context={`Source: ${evidence?.source || "unavailable"} · Updated: ${date(evidence?.lastUpdatedAt)} · ${evidence?.freshness || "unavailable"}`} />
    {error ? <ErrorState message={error} /> : null}
    <section className="panel-flat"><p className="eyebrow">Current infrastructure</p><h2>{authority?.infrastructure?.status?.replaceAll("_", " ") || "Unavailable"}</h2><p>{authority?.reason}</p><div className="active-run-list">{evidence?.resources?.map((resource) => <article className="active-run-item" key={resource.type}><strong>{resource.type}</strong><span>{resource.status}</span></article>)}</div><dl><div><dt>Region</dt><dd>{evidence?.region || "Unavailable"}</dd></div><div><dt>Execution</dt><dd>GitHub Actions</dd></div><div><dt>Application health</dt><dd>{authority?.applicationHealth?.status || "unavailable"}</dd></div><div><dt>ECR repository</dt><dd>{evidence?.ecr?.repository || "Unavailable"}</dd></div><div><dt>Immutable image</dt><dd>{evidence?.ecr?.imageTag || "Unavailable"}</dd></div><div><dt>Image digest</dt><dd>{evidence?.ecr?.imageDigest || "Unavailable"}</dd></div><div><dt>ECS cluster / service</dt><dd>{evidence?.ecs ? `${evidence.ecs.cluster} / ${evidence.ecs.service}` : "Unavailable"}</dd></div><div><dt>Task definition</dt><dd>{evidence?.ecs?.taskDefinitionRevision ? `Revision ${evidence.ecs.taskDefinitionRevision}` : "Unavailable"}</dd></div><div><dt>ECS tasks</dt><dd>{evidence?.ecs ? `${evidence.ecs.runningCount} running · ${evidence.ecs.desiredCount} desired · ${evidence.ecs.pendingCount} pending` : "Unavailable"}</dd></div><div><dt>ALB / targets</dt><dd>{evidence?.alb ? `${evidence.alb.status} · ${evidence.alb.targetHealth.join(", ") || "no targets"}` : "Unavailable"}</dd></div><div><dt>Live endpoint</dt><dd>{evidence?.alb?.endpoint || "Unavailable"}</dd></div></dl></section>
    <section className="panel-flat"><p className="eyebrow">Terraform &amp; FinOps</p><h2>Remote state and estimated cost</h2><dl><div><dt>State</dt><dd>{evidence?.terraformState?.status || "unavailable"}</dd></div><div><dt>Storage</dt><dd>{evidence?.terraformState?.storage === "encrypted_s3" ? "Encrypted S3" : "Unavailable"}</dd></div><div><dt>State key</dt><dd>{evidence?.terraformState?.key || "Unavailable"}</dd></div><div><dt>Last apply</dt><dd>{date(evidence?.terraformState?.lastApplyAt)}</dd></div><div><dt>Last destroy</dt><dd>{date(evidence?.terraformState?.lastDestroyAt)}</dd></div><div><dt>Infracost</dt><dd>{cost?.status === "estimated" ? `${cost.currency || "USD"} ${cost.monthly}/month` : "Unavailable — no verified Infracost estimate"}</dd></div></dl></section>
    {evidence?.persistentStorage ? <section className="panel-flat"><p className="eyebrow">Persistent storage</p><h2>EFS</h2><p>{evidence.persistentStorage.status} · {evidence.persistentStorage.encrypted ? "encrypted" : "encryption unavailable"} · backups {evidence.persistentStorage.backupEnabled ? "enabled" : "disabled"}</p></section> : null}
    <section className="panel-flat settings-link-card"><div><p className="eyebrow">Portability</p><h2>Export Terraform</h2><p>Download a short-lived sanitized configuration bundle. Terraform state, plans, caches, tfvars, and credentials are excluded.</p></div>{project?.canManage ? <button className="secondary-button" disabled={exportBusy} onClick={exportTerraform} type="button">{exportBusy ? "Preparing…" : "Export ZIP"}</button> : <p className="muted">Only the project owner can create an export.</p>}</section>
  </div>;
}
