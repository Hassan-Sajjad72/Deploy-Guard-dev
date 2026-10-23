import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { getProject } from "../api/projectApi.js";
import { getAwsBindings } from "../api/workspaceApi.js";
import { createCustomerLifecyclePlan, executeDeploymentPlan, createDeploymentPlan, decideDeploymentPlan, getDeploymentPlan, interpretDeploymentGoal, listDeploymentPlans } from "../api/planningApi.js";
import { Button, Callout, PageHeader } from "../components/common/DesignSystem.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { getIntelligenceRecord } from "../api/intelligenceApi.js";

const profiles = { ecs_fargate: "ECS Fargate", ec2: "EC2", lightsail: "Lightsail", lambda: "Lambda", static: "S3 + CloudFront" };
const suggestionLabels = { monthlyBudgetUsd: "Monthly AWS budget (USD)", availability: "Availability", stateful: "Persistent application state", continuousCompute: "Continuously running compute" };
const numericFields = [
  ["cpu", "CPU per service (vCPU)", 0.25, 0.25], ["memoryMiB", "Memory per service (MiB)", 512, 1],
  ["storageGiB", "Persistent storage (GiB)", 20, 1], ["replicas", "Replicas per service", 1, 1],
  ["monthlyRequests", "Monthly requests", 100000, 1], ["monthlyTransferGiB", "Monthly outbound transfer (GiB)", 10, 0.01],
  ["monthlyLogGiB", "Monthly log ingestion (GiB)", 1, 0.01], ["monthlyBudgetUsd", "Maximum monthly AWS budget (USD)", 50, 0.01],
];

const pricingFields = [["imageStorageGiB", "Total retained container images (GiB)"], ["publicIpv4Count", "Public IPv4 addresses, including tasks and ALBs"], ["albNewConnectionsPerSecond", "New connections per second per ALB"], ["albActiveConnectionsPerMinute", "Active connections per minute per ALB"], ["albRuleEvaluationsPerSecond", "Rule evaluations per second per ALB"], ["monthlyIntraRegionGiB", "Monthly cross-zone transfer (GiB)"], ["stateStorageGiB", "Terraform state storage (GiB)"], ["monthlyStateWriteRequests", "Monthly state write and list requests"], ["monthlyStateReadRequests", "Monthly state read requests"], ["monthlySecretApiRequests", "Monthly secret API requests"], ["backupStorageGiB", "Retained database backups (GiB)"]];

export default function ProjectPlanning() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const optimizationId = searchParams.get("optimization");
  const [optimization, setOptimization] = useState(null);
  const generation = useRef(0);
  const [project, setProject] = useState(null);
  const [bindings, setBindings] = useState([]);
  const [plans, setPlans] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pricingReviewed, setPricingReviewed] = useState(false);
  const [suggestions, setSuggestions] = useState(null);
  const [assumptions, setAssumptions] = useState({ ...Object.fromEntries(numericFields.map(([key, , value]) => [key, value])), availability: "single_instance", stateful: false, continuousCompute: true });
  const canManage = project?.canManage === true;
  useEffect(() => {
    let active = true; setOptimization(null);
    if (optimizationId) getIntelligenceRecord(projectId, optimizationId).then(({ record }) => { if (active && record.kind === "optimization") setOptimization(record); }).catch((caught) => { if (active) setError(caught.message); });
    return () => { active = false; };
  }, [projectId, optimizationId]);

  useEffect(() => {
    const current = ++generation.current;
    setLoading(true); setBusy(false); setSelected(null); setSuggestions(null); setProject(null); setPlans([]); setBindings([]); setError("");
    Promise.all([getProject(projectId), listDeploymentPlans(projectId)]).then(async ([result, history]) => {
      const accounts = result.project.organizationId ? await getAwsBindings(result.project.organizationId) : { bindings: [] };
      const latest = history.plans[0] ? await getDeploymentPlan(projectId, history.plans[0].id) : null;
      if (current === generation.current) { setProject(result.project); setPlans(history.plans); setBindings(accounts.bindings.filter((binding) => binding.verificationStatus !== "revoked")); setSelected(latest); }
    }).catch((caught) => { if (current === generation.current) setError(caught.message); })
      .finally(() => { if (current === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [projectId]);

  async function action(work) {
    const current = generation.current;
    setBusy(true); setError("");
    try { await work(current); } catch (caught) { if (current === generation.current) setError(caught.message); }
    finally { if (current === generation.current) setBusy(false); }
  }
  async function create(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await action(async (current) => {
      const infrastructure = { executionRolePermissionsBoundaryArn: String(form.get("executionRolePermissionsBoundaryArn") || "").trim() || undefined, vpcId: String(form.get("vpcId") || "").trim(), publicSubnetIds: String(form.get("publicSubnetIds") || "").split(",").map((id) => id.trim()).filter(Boolean), terraformStateBucket: String(form.get("terraformStateBucket") || "").trim() };
      const { plan } = await createDeploymentPlan(projectId, { ...(infrastructure.vpcId || infrastructure.publicSubnetIds.length || infrastructure.terraformStateBucket ? { infrastructure } : {}), bindingId: form.get("bindingId"), region: form.get("region"), profile: form.get("profile"), assumptions: { ...assumptions, ...(pricingReviewed ? { pricing: Object.fromEntries(pricingFields.map(([key]) => [key, Number(form.get(`pricing-${key}`))])) } : {}) } });
      const [history, detail] = await Promise.all([listDeploymentPlans(projectId), getDeploymentPlan(projectId, plan.id)]);
      if (current === generation.current) { setPlans(history.plans); setSelected(detail); }
    });
  }
  async function prepareLifecycle(event) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    await action(async (current) => {
      const { plan } = await createCustomerLifecyclePlan(projectId, { action: form.get("action"), ...(form.get("targetOperationId") ? { targetOperationId: form.get("targetOperationId") } : {}), monthlyBudgetUsd: Number(form.get("monthlyBudgetUsd")), reason: form.get("reason"), confirmationPhrase: form.get("confirmationPhrase") || undefined });
      const [history, detail] = await Promise.all([listDeploymentPlans(projectId), getDeploymentPlan(projectId, plan.id)]);
      if (current === generation.current) { setPlans(history.plans); setSelected(detail); }
    });
  }
  async function interpret(event) {
    event.preventDefault();
    const prompt = String(new FormData(event.currentTarget).get("prompt"));
    await action(async (current) => { const result = await interpretDeploymentGoal(projectId, prompt); if (current === generation.current) setSuggestions(result.suggestions); });
  }
  function applySuggestions() {
    const proposed = Object.fromEntries(Object.entries(suggestions).filter(([key, value]) => key !== "explanation" && value !== null));
    setAssumptions((current) => ({ ...current, ...proposed })); setSuggestions(null);
  }
  function decide(decision) {
    void action(async (current) => {
      await decideDeploymentPlan(projectId, selected.plan.id, { decision, fingerprint: selected.plan.fingerprint, reason: decision === "approved" ? "Reviewed deployment plan and cost assumptions." : "Rejected after review." });
      const updated = await getDeploymentPlan(projectId, selected.plan.id);
      if (current === generation.current) setSelected(updated);
    });
  }
  if (loading) return <LoadingState message="Loading deployment plans…" />;
  const content = selected?.plan.content;
  return <div className="page settings-page">
    <PageHeader title="Deployment planning" description="Review exact source, workload assumptions, hosting compatibility and pricing before approving customer deployment." />
    {error ? <Callout tone="danger" title="Unable to complete this action"><p role="alert">{error}</p></Callout> : null}
    {canManage && optimization?.content.recommendations?.length ? <Callout title="Measured optimization to review"><p>Recommendation based on {optimization.content.window.start} to {optimization.content.window.end}; confidence {optimization.content.confidence}. Workload settings apply to every service in this plan. Review service compatibility, availability and fresh pricing before creating and approving a new plan.</p><Button disabled={busy} onClick={() => { const proposal = optimization.content.recommendations[0]; setAssumptions((current) => ({ ...current, cpu: proposal.cpu, memoryMiB: proposal.memoryMiB, replicas: proposal.replicas })); setOptimization(null); }}>Use measured settings in review form</Button></Callout> : null}
    <Callout title="Customer hosting availability"><p>Customer execution requires verified provider evidence for the selected region, a current account binding, complete pricing and approval of this exact plan.</p></Callout>
    {canManage ? <>
      <details className="disclosure"><summary>Describe a deployment goal</summary><form onSubmit={interpret}>
        <label className="field"><span>Deployment goal</span><textarea name="prompt" required maxLength={2000} disabled={busy} placeholder="A continuously running API, single instance, within 50 USD per month." /></label>
        <p>Enter deployment requirements only. Keep credentials and secret values in service configuration.</p>
        <Button type="submit" disabled={busy}>Interpret goal</Button>
      </form>{suggestions ? <Callout title="Suggested workload settings"><p>{suggestions.explanation}</p><dl>{Object.entries(suggestions).filter(([key]) => key !== "explanation").map(([key, value]) => <div key={key}><dt>{suggestionLabels[key]}</dt><dd>{value === null ? "Needs your input" : value === "single_instance" ? "Single instance" : value === "multi_zone" ? "Multiple availability zones" : typeof value === "boolean" ? value ? "Required" : "Not required" : String(value)}</dd></div>)}</dl><Button disabled={busy} onClick={applySuggestions}>Use suggestions in review form</Button></Callout> : null}</details>
      {bindings.length ? <form className="panel" onSubmit={create}><h2>Create an immutable plan</h2>
        <div className="field"><label htmlFor="plan-binding">AWS account binding</label><select id="plan-binding" name="bindingId" required disabled={busy}>{bindings.map((binding) => <option key={binding.id} value={binding.id}>{binding.accountId} · {binding.verificationStatus}</option>)}</select></div>
        <label className="field"><span>AWS region</span><input name="region" required pattern="[a-z]{2}(-[a-z]+)+-[0-9]" defaultValue={bindings[0]?.regions[0] || ""} disabled={busy} /></label>
        <div className="field"><label htmlFor="plan-profile">Hosting profile to review</label><select id="plan-profile" name="profile" disabled={busy}>{Object.entries(profiles).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
        <fieldset disabled={busy}><legend>Customer network and state storage</legend>
          <label className="field"><span>Customer ECS task-role boundary ARN</span><input name="executionRolePermissionsBoundaryArn" placeholder="arn:aws:iam::123456789012:policy/deployguard/project-id/ecs-task-boundary" /></label>
          <label className="field"><span>VPC ID</span><input name="vpcId" pattern="vpc-[0-9a-f]{8}([0-9a-f]{9})?" placeholder="vpc-0123456789abcdef0" /></label>
          <label className="field"><span>Public subnet IDs in at least two availability zones, separated by commas</span><input name="publicSubnetIds" placeholder="subnet-0123456789abcdef0, subnet-abcdef01234567890" /></label>
          <label className="field"><span>Customer Terraform state bucket</span><input name="terraformStateBucket" pattern="[a-z0-9][a-z0-9-]{1,61}[a-z0-9]" /></label>
          <p>These customer-owned resources become immutable plan inputs. Execution verifies account, region, availability zones and public routes.</p>
        </fieldset>
        {numericFields.map(([key, label, , step]) => <label className="field" key={key}><span>{label}</span><input name={key} type="number" required min={key === "replicas" ? 1 : key === "cpu" ? 0.25 : key === "memoryMiB" ? 256 : 0} step={step} value={assumptions[key]} disabled={busy} onChange={(event) => setAssumptions((current) => ({ ...current, [key]: Number(event.target.value) }))} /></label>)}
        <details className="disclosure"><summary>Additional quantities for complete AWS pricing</summary>
          <p>Review these estimates for the sealed topology. Public addresses must cover application tasks and two ALB addresses per service. Image storage includes retained releases. State requests, secret access, logs, transfer and retained backups can add charges.</p>
          <label><input type="checkbox" checked={pricingReviewed} disabled={busy} onChange={(event) => setPricingReviewed(event.target.checked)} /> Include reviewed additional pricing quantities</label>
          {pricingReviewed ? pricingFields.map(([key, label]) => <label className="field" key={key}><span>{label}</span><input name={`pricing-${key}`} type="number" required min={0} step={["imageStorageGiB", "monthlyIntraRegionGiB", "stateStorageGiB", "backupStorageGiB"].includes(key) ? 0.01 : 1} disabled={busy} /></label>) : null}
        </details>
        <div className="field"><label htmlFor="plan-availability">Availability requirement</label><select id="plan-availability" value={assumptions.availability} disabled={busy} onChange={(event) => setAssumptions((current) => ({ ...current, availability: event.target.value }))}><option value="single_instance">Single instance</option><option value="multi_zone">Multiple availability zones</option></select></div>
        <label><input type="checkbox" checked={assumptions.stateful} disabled={busy} onChange={(event) => setAssumptions((current) => ({ ...current, stateful: event.target.checked }))} /> Requires persistent application state</label>
        <label><input type="checkbox" checked={assumptions.continuousCompute} disabled={busy} onChange={(event) => setAssumptions((current) => ({ ...current, continuousCompute: event.target.checked }))} /> Requires continuously running compute</label>
        <label><input type="checkbox" required disabled={busy} /> I reviewed these workload and budget assumptions.</label>
        <Button type="submit" disabled={busy}>Analyze and create plan</Button>
      </form> : <Callout title="Connect an AWS account"><p>Add a customer AWS account binding before creating a plan.</p><Link to="/workspaces">Manage AWS accounts</Link></Callout>}
    </> : null}
    {canManage && project?.executionMode === "customer" ? <details className="disclosure"><summary>Review a retained customer rollback or cleanup</summary><form onSubmit={prepareLifecycle}>
      <label className="field"><span>Customer lifecycle action</span><select name="action" disabled={busy}><option value="rollback">Rollback to a verified retained release</option><option value="destroy">Cleanup verified customer infrastructure</option></select></label>
      <label className="field"><span>Retained deployment operation ID for rollback</span><input name="targetOperationId" disabled={busy} placeholder="Exact retained operation UUID" /></label>
      <label className="field"><span>Approved monthly AWS budget (USD)</span><input name="monthlyBudgetUsd" type="number" required min="0" step="0.01" disabled={busy} /></label>
      <label className="field"><span>Review reason</span><textarea name="reason" required maxLength={1000} disabled={busy} /></label>
      <label className="field"><span>For cleanup, type DESTROY</span><input name="confirmationPhrase" disabled={busy} autoComplete="off" /></label>
      <p>Cleanup deletes verified customer generations, managed storage and runtime secrets. Preparation creates an immutable plan with fresh pricing and retained ownership evidence for separate review and approval.</p>
      <Button type="submit" disabled={busy}>Prepare lifecycle review</Button>
    </form></details> : null}
    <section className="panel"><h2>Plan history</h2>{plans.length ? <div className="field"><label htmlFor="plan-history">Plan version</label><select id="plan-history" value={selected?.plan.id || ""} disabled={busy} onChange={(event) => { const id = event.target.value; void action(async (current) => { const result = await getDeploymentPlan(projectId, id); if (current === generation.current) setSelected(result); }); }}>{plans.map((plan) => <option key={plan.id} value={plan.id}>Version {plan.version} · {plan.content.status}</option>)}</select></div> : <p>No deployment plans yet.</p>}</section>
    {content ? <section className="panel"><h2>Version {selected.plan.version} · {content.status.replaceAll("_", " ")}</h2>
      <p>Action: {content.deploymentAction || "deploy"}{content.lifecycle ? ` · retained operation ${content.lifecycle.targetOperationId}` : ""}</p>
      <p>Account {content.ownership.accountId} · {content.ownership.region} · {profiles[content.selectedProfile]}</p><p className="mono" style={{ overflowWrap: "anywhere" }}>Source SHA: {content.repository.sourceSha}</p>
      <p className="mono" style={{ overflowWrap: "anywhere" }}>Plan fingerprint: {selected.plan.fingerprint}</p>
      {content.infrastructure ? <p>Customer network: {content.infrastructure.vpcId} · {content.infrastructure.publicSubnetIds.join(", ")} · state bucket {content.infrastructure.terraformStateBucket}</p> : null}
      <h3>Services and configuration</h3><ul>{content.services.map((service) => <li key={service.id}>{service.name} · {service.directory} · port {service.port}</li>)}</ul>
      <p>{content.environmentReferences.length} service configuration references. Secret values are excluded.</p>
      {content.blockers.length ? <Callout title="Approval blocked" tone="warning"><ul>{content.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></Callout> : null}
      <h3>Hosting comparison</h3>{content.comparison.options.map((option) => <details className="disclosure" key={option.id}><summary>{profiles[option.id]} · {option.cost.monthlyUsd === null ? "Incomplete estimate" : `${option.cost.monthlyUsd.toFixed(2)} USD/month`} · {option.eligible ? "Eligible" : "Unavailable or blocked"}</summary><ul>{option.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul><dl>{option.cost.items.map((item, index) => <div key={`${item.category}-${index}`}><dt>{item.category.replaceAll("_", " ")}</dt><dd>{item.monthlyUsd === null ? "Unknown" : `${item.monthlyUsd.toFixed(2)} USD/month`} · {item.kind} · {item.reason}</dd></div>)}</dl></details>)}
      <h3>Risks and security evidence</h3><ul>{[...content.risks, ...content.securityFindings.map((finding) => finding.reason)].map((risk) => <li key={risk}>{risk}</li>)}</ul>
      {selected.decision ? <><p role="status">Decision: {selected.decision.decision}</p>{canManage && selected.decision.decision === "approved" ? <Button disabled={busy || content.blockers.length > 0 || !content.comparison.options.find((option) => option.id === content.selectedProfile)?.eligible} onClick={() => void action(async () => { const result = await executeDeploymentPlan(projectId, selected.plan.id, selected.plan.fingerprint); if (result.deployment?.state === "accepted" || result.deployment?.state === "no_op") navigate(`/projects/${projectId}`); else throw new Error(result.deployment?.message || "Deployment could not start."); })}>Execute this approved plan</Button> : null}</> : selected.canApprove ? <div className="actions"><Button disabled={busy || content.status !== "review_required" || content.blockers.length > 0} onClick={() => decide("approved")}>Approve this plan</Button><Button disabled={busy} onClick={() => decide("rejected")}>Reject this plan</Button></div> : null}
    </section> : null}
  </div>;
}
