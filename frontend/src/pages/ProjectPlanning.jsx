import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { getProject, getProjectServices } from "../api/projectApi.js";
import { getAwsBindings } from "../api/workspaceApi.js";
import { createCustomerLifecyclePlan, executeDeploymentPlan, createDeploymentPlan, decideDeploymentPlan, getDeploymentPlan, interpretDeploymentGoal, listDeploymentPlans, getProviderArtifacts, listProviderGenerations, actOnProviderGeneration, getProviderRuntime, startHostingBuild, getHostingBuild } from "../api/planningApi.js";
import { Button, Callout, PageHeader } from "../components/common/DesignSystem.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { getIntelligenceRecord } from "../api/intelligenceApi.js";

const profiles = { ecs_fargate: "ECS Fargate", ec2: "EC2", lightsail: "Lightsail", lambda: "Lambda", static: "S3 + CloudFront" };
const dependencyKinds = { database: "Database", cache: "Cache", queue: "Queue", object_storage: "Object storage", external_service: "External service" };
const suggestionLabels = { monthlyBudgetUsd: "Monthly AWS budget (USD)", availability: "Availability", stateful: "Persistent application state", continuousCompute: "Continuously running compute" };
const numericFields = [
  ["cpu", "CPU per service (vCPU)", 0.25, 0.25], ["memoryMiB", "Memory per service (MiB)", 512, 1],
  ["storageGiB", "Persistent storage (GiB)", 20, 1], ["replicas", "Replicas per service", 1, 1],
  ["monthlyRequests", "Monthly requests", 100000, 1], ["monthlyTransferGiB", "Monthly outbound transfer (GiB)", 10, 0.01],
  ["monthlyLogGiB", "Monthly log ingestion (GiB)", 1, 0.01], ["monthlyBudgetUsd", "Maximum monthly AWS budget (USD)", 50, 0.01],
];

const pricingFields = [["imageStorageGiB", "Total retained container images (GiB)"], ["publicIpv4Count", "Public IPv4 addresses, including tasks and ALBs"], ["albNewConnectionsPerSecond", "New connections per second per ALB"], ["albActiveConnectionsPerMinute", "Active connections per minute per ALB"], ["albRuleEvaluationsPerSecond", "Rule evaluations per second per ALB"], ["monthlyIntraRegionGiB", "Monthly cross-zone transfer (GiB)"], ["stateStorageGiB", "Terraform state storage (GiB)"], ["monthlyStateWriteRequests", "Monthly state write and list requests"], ["monthlyStateReadRequests", "Monthly state read requests"], ["monthlySecretApiRequests", "Monthly secret API requests"], ["backupStorageGiB", "Retained database backups (GiB)"]];

// Starter shapes for the sealed provider builders. Build evidence (assets, hashes, scans, images) is generated automatically and merged server-side.
const vmBase = { availability: "single_instance", replicas: 1, localPersistence: false, services: [{ id: "", port: 8080, cpu: 0.5, memoryMiB: 512, publicEnvironment: {}, secretReferences: [], image: "", runAs: "" }], entrypointServiceId: "", healthPath: "/health", proxy: { kind: "", image: "", verifiedDigest: "" }, architecture: "arm64", dns: { zoneId: "", zoneName: "" } };
const profileTemplates = {
  ec2: { ...vmBase, ami: { id: "", ownerId: "", os: "", architecture: "arm64" }, instanceType: "", vpcId: "", subnetId: "", rootStorageGiB: 20, instanceCpu: 2, instanceMemoryMiB: 2048 },
  lightsail: { ...vmBase, blueprint: { id: "", os: "" }, bundle: { id: "", cpu: 2, memoryMiB: 2048, storageGiB: 60, includedTransferGiB: 3072, overagePricingRequired: true }, availabilityZone: "" },
  static: { spa: true, priceClass: "PriceClass_100", healthPath: "/" },
  lambda: { serviceId: "", architecture: "arm64", publicEnvironment: {}, secretReferences: [], timeoutSeconds: 29, memoryMiB: 512, ephemeralStorageMiB: 512, reservedConcurrency: 0, requestsPerSecond: 50, burstLimit: 100, healthPath: "/health", authorization: "public_application_endpoint" },
};

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
  const [providerHistory, setProviderHistory] = useState(null);
  const [artifacts, setArtifacts] = useState(null);
  const [notice, setNotice] = useState("");
  const [runtime, setRuntime] = useState(null);
  const [services, setServices] = useState([]);
  const [hostingBuild, setHostingBuild] = useState(null);
  const [planProfile, setPlanProfile] = useState("ecs_fargate");
  const [profileInputs, setProfileInputs] = useState("");
  const [assumptions, setAssumptions] = useState({ ...Object.fromEntries(numericFields.map(([key, , value]) => [key, value])), availability: "single_instance", stateful: false, continuousCompute: true });
  const canManage = project?.canManage === true;
  useEffect(() => {
    let active = true; setOptimization(null);
    if (optimizationId) getIntelligenceRecord(projectId, optimizationId).then(({ record }) => { if (active && record.kind === "optimization") setOptimization(record); }).catch((caught) => { if (active) setError(caught.message); });
    return () => { active = false; };
  }, [projectId, optimizationId]);

  useEffect(() => {
    const current = ++generation.current;
    setLoading(true); setBusy(false); setSelected(null); setSuggestions(null); setProject(null); setPlans([]); setBindings([]); setError(""); setProviderHistory(null); setArtifacts(null); setNotice(""); setRuntime(null); setServices([]); setHostingBuild(null);
    Promise.all([getProject(projectId), listDeploymentPlans(projectId), listProviderGenerations(projectId).catch(() => null), getProjectServices(projectId).catch(() => ({ services: [] }))]).then(async ([result, history, providers, deployable]) => {
      const accounts = result.project.organizationId ? await getAwsBindings(result.project.organizationId) : { bindings: [] };
      const latest = history.plans[0] ? await getDeploymentPlan(projectId, history.plans[0].id) : null;
      if (current === generation.current) { setProject(result.project); setPlans(history.plans); setBindings(accounts.bindings.filter((binding) => binding.verificationStatus !== "revoked")); setSelected(latest); setProviderHistory(providers); setServices(deployable.services || []); }
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
    let sealedInputs;
    if (planProfile !== "ecs_fargate") {
      try { sealedInputs = JSON.parse(profileInputs); } catch { setError("Profile configuration must be valid JSON."); return; }
      if (!sealedInputs || typeof sealedInputs !== "object" || Array.isArray(sealedInputs)) { setError("Profile configuration must be a JSON object."); return; }
    }
    await action(async (current) => {
      const infrastructure = { executionRolePermissionsBoundaryArn: String(form.get("executionRolePermissionsBoundaryArn") || "").trim() || undefined, vpcId: String(form.get("vpcId") || "").trim(), publicSubnetIds: String(form.get("publicSubnetIds") || "").split(",").map((id) => id.trim()).filter(Boolean), terraformStateBucket: String(form.get("terraformStateBucket") || "").trim() };
      const { plan } = await createDeploymentPlan(projectId, { ...(infrastructure.vpcId || infrastructure.publicSubnetIds.length || infrastructure.terraformStateBucket ? { infrastructure } : {}), bindingId: form.get("bindingId"), region: form.get("region"), profile: planProfile, ...(sealedInputs ? { profileInputs: sealedInputs } : {}), ...(hostingBuild?.status === "succeeded" && hostingBuild.profile === planProfile ? { buildId: hostingBuild.buildId } : {}), assumptions: { ...assumptions, ...(pricingReviewed ? { pricing: { ...Object.fromEntries(pricingFields.map(([key]) => [key, Number(form.get(`pricing-${key}`))])), ...(form.get("pricing-averageRequestDurationMs") ? { averageRequestDurationMs: Number(form.get("pricing-averageRequestDurationMs")) } : {}) } } : {}) } });
      const [history, detail] = await Promise.all([listDeploymentPlans(projectId), getDeploymentPlan(projectId, plan.id)]);
      if (current === generation.current) { setPlans(history.plans); setSelected(detail); }
    });
  }
  async function generateBuild(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = { profile: planProfile, serviceId: String(form.get("serviceId")), ...(planProfile === "lambda" ? { handler: String(form.get("handler")), runtime: String(form.get("runtime")) } : {}) };
    await action(async (current) => {
      let { build } = await startHostingBuild(projectId, body);
      if (current === generation.current) setHostingBuild(build);
      // Builds and scans run in an isolated container for minutes; poll until they finish.
      while (build.status === "running" && current === generation.current) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        ({ build } = await getHostingBuild(projectId, build.buildId));
        if (current === generation.current) setHostingBuild(build);
      }
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
    {notice ? <Callout title="Provider deployment"><p role="status">{notice}</p></Callout> : null}
    {canManage && optimization?.content.recommendations?.length ? <Callout title="Measured optimization to review"><p>Recommendation based on {optimization.content.window.start} to {optimization.content.window.end}; confidence {optimization.content.confidence}. Workload settings apply to every service in this plan. Review service compatibility, availability and fresh pricing before creating and approving a new plan.</p><Button disabled={busy} onClick={() => { const proposal = optimization.content.recommendations[0]; setAssumptions((current) => ({ ...current, cpu: proposal.cpu, memoryMiB: proposal.memoryMiB, replicas: proposal.replicas, ...(Number.isFinite(proposal.monthlyRequests) ? { monthlyRequests: proposal.monthlyRequests } : {}) })); setOptimization(null); }}>Use measured settings in review form</Button>{optimization.content.recommendations.map((item) => <p key={item.reason}>{item.reason}</p>)}{(optimization.content.observations || []).filter((item) => typeof item === "string").map((item) => <p key={item}>{item}</p>)}</Callout> : null}
    <Callout title="Customer hosting availability"><p>Customer execution requires verified provider evidence for the selected region, a current account binding, complete pricing and approval of this exact plan.</p></Callout>
    {canManage ? <>
      <details className="disclosure"><summary>Describe a deployment goal</summary><form onSubmit={interpret}>
        <label className="field"><span>Deployment goal</span><textarea name="prompt" required maxLength={2000} disabled={busy} placeholder="A continuously running API, single instance, within 50 USD per month." /></label>
        <p>Enter deployment requirements only. Keep credentials and secret values in service configuration.</p>
        <Button type="submit" disabled={busy}>Interpret goal</Button>
      </form>{suggestions ? <Callout title="Suggested workload settings"><p>{suggestions.explanation}</p><dl>{Object.entries(suggestions).filter(([key]) => key !== "explanation").map(([key, value]) => <div key={key}><dt>{suggestionLabels[key]}</dt><dd>{value === null ? "Needs your input" : value === "single_instance" ? "Single instance" : value === "multi_zone" ? "Multiple availability zones" : typeof value === "boolean" ? value ? "Required" : "Not required" : String(value)}</dd></div>)}</dl><Button disabled={busy} onClick={applySuggestions}>Use suggestions in review form</Button></Callout> : null}</details>
      {bindings.length && planProfile !== "ecs_fargate" ? <form className="panel" onSubmit={generateBuild}><h2>{profiles[planProfile]} build evidence</h2>
        <p>{planProfile === "lightsail" ? "Uses digest-pinned public images that the release pipeline already built and Trivy-scanned for the current commit; Lightsail instances cannot pull private images." : planProfile === "ec2" ? "Builds the service Dockerfile at the current commit, scans the image with Trivy and seals its digest. The exact image is pushed to your account's ECR only when the approved plan runs." : "Builds the current commit in an isolated container, scans it with Trivy and records every artifact hash."} Plans for this profile need passing evidence for the same commit.</p>
        <div className="field"><label htmlFor="build-service">Service</label><select id="build-service" name="serviceId" required disabled={busy}>{services.map((service) => <option key={service.id} value={service.id}>{service.name} · {service.serviceDirectory}</option>)}</select></div>
        {planProfile === "lambda" ? <><label className="field"><span>Lambda handler</span><input name="handler" required defaultValue="index.handler" pattern="[A-Za-z0-9_/.\-]+\.[A-Za-z0-9_]+" disabled={busy} /></label>
          <div className="field"><label htmlFor="build-runtime">Lambda runtime</label><select id="build-runtime" name="runtime" disabled={busy}><option value="nodejs22.x">Node.js 22</option><option value="python3.12">Python 3.12</option></select></div></> : null}
        <Button type="submit" disabled={busy || !services.length}>Generate build evidence</Button>
        {hostingBuild ? <p role="status">Build {hostingBuild.buildId.slice(0, 8)}: {hostingBuild.status === "running" ? "building and scanning…" : hostingBuild.status === "failed" ? `failed. ${hostingBuild.error || ""}` : `source ${hostingBuild.sourceSha.slice(0, 12)}, security scan ${hostingBuild.securityScan.status}${hostingBuild.securityScan.status === "passed" ? ". It will be sealed into the next plan." : ". Fix the findings and rebuild."}`}</p> : null}
      </form> : null}
      {bindings.length ? <form className="panel" onSubmit={create}><h2>Create an immutable plan</h2>
        <div className="field"><label htmlFor="plan-binding">AWS account binding</label><select id="plan-binding" name="bindingId" required disabled={busy}>{bindings.map((binding) => <option key={binding.id} value={binding.id}>{binding.accountId} · {binding.verificationStatus}</option>)}</select></div>
        <label className="field"><span>AWS region</span><input name="region" required pattern="[a-z]{2}(-[a-z]+)+-[0-9]" defaultValue={bindings[0]?.regions[0] || ""} disabled={busy} /></label>
        <div className="field"><label htmlFor="plan-profile">Hosting profile to review</label><select id="plan-profile" name="profile" value={planProfile} disabled={busy} onChange={(event) => { const next = event.target.value; setPlanProfile(next); setHostingBuild(null); setProfileInputs(next === "ecs_fargate" ? "" : JSON.stringify(profileTemplates[next], null, 2)); }}>{Object.entries(profiles).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
        {planProfile !== "ecs_fargate" ? <label className="field"><span>{profiles[planProfile]} configuration (JSON)</span><textarea className="mono" rows={14} required spellCheck={false} value={profileInputs} disabled={busy} onChange={(event) => setProfileInputs(event.target.value)} />
          <small>Describe resources and runtime settings. Build evidence is added automatically from the generated build. Use secret references only, never secret values. The plan is checked against the provider artifact contract before approval.</small></label> : null}
        <fieldset disabled={busy}><legend>Customer network and state storage</legend>
          <label className="field"><span>Customer ECS task-role boundary ARN</span><input name="executionRolePermissionsBoundaryArn" placeholder="arn:aws:iam::123456789012:policy/deployguard/project-id/ecs-task-boundary-project-id" /></label>
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
          {pricingReviewed ? <label className="field"><span>Average request duration for Lambda (ms, optional)</span><input name="pricing-averageRequestDurationMs" type="number" min={1} max={29000} step={1} disabled={busy} /></label> : null}
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
    {providerHistory?.generations?.length ? <section className="panel"><h2>Provider generations</h2>
      <p>Recorded generation evidence. Observe the live generation before rolling back or cleaning up.</p>
      {providerHistory.route ? <div className="actions"><Button disabled={busy} onClick={() => void action(async (current) => { const observed = await getProviderRuntime(projectId); if (current === generation.current) setRuntime(observed); })}>Observe live generation</Button></div> : null}
      {runtime?.status === "live" ? <Callout tone={runtime.endpoint.application === "healthy" ? undefined : "warning"} title={`Observed ${new Date(runtime.endpoint.observedAt).toLocaleString()}`}>
        <p role="status">Endpoint {runtime.endpoint.transport} · application {runtime.endpoint.application}{runtime.endpoint.httpStatus ? ` (HTTP ${runtime.endpoint.httpStatus} on ${runtime.endpoint.healthPath})` : ""}</p>
        <p>{runtime.endpoint.reason}</p>
        {runtime.metricsStatus === "observed" ? (runtime.metrics.length ? <ul>{Object.entries(runtime.metrics.reduce((latest, row) => (!latest[row.metric] || latest[row.metric].timestamp < row.timestamp ? { ...latest, [row.metric]: row } : latest), {})).map(([metric, row]) => <li key={metric}>{metric.replaceAll("_", " ")}: {Number(row.value).toFixed(2)} at {new Date(row.timestamp).toLocaleTimeString()}</li>)}</ul> : <p>No AWS metric datapoints in the last 24 hours.</p>) : <p>Metrics unavailable: {runtime.metricsReason}</p>}
        <p>Measured values from account {runtime.accountId} in {runtime.region}. These are observations, not estimates.</p>
      </Callout> : runtime?.status === "no_live_generation" ? <p role="status">No verified live provider generation to observe.</p> : null}
      <ul>{providerHistory.generations.map((item) => <li key={item.id}>
        <p>{profiles[item.profile] || item.profile} · {item.status}{providerHistory.route?.generationId === item.id ? " · live route" : ""} · {new Date(item.createdAt).toLocaleString()}</p>
        <p className="mono" style={{ overflowWrap: "anywhere" }}>Generation {item.id}</p>
        {canManage && item.runtimeIdentity && item.status !== "deleted" ? <details className="disclosure"><summary>Rollback or clean up this generation</summary><form onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const kind = form.get("action");
          if (kind === "cleanup" && form.get("confirmation") !== "DESTROY") { setError("Type DESTROY to confirm generation cleanup."); return; }
          void action(async (current) => { await actOnProviderGeneration(projectId, item.id, kind, { artifactFingerprint: item.artifactFingerprint, reason: String(form.get("reason")) }); const updated = await listProviderGenerations(projectId); if (current === generation.current) { setProviderHistory(updated); setNotice(kind === "rollback" ? "Route moved to the retained generation." : "Generation resources deleted."); } }); }}>
          <div className="field"><label htmlFor={`generation-action-${item.id}`}>Action</label><select id={`generation-action-${item.id}`} name="action" disabled={busy}><option value="rollback">Route traffic back to this generation</option><option value="cleanup">Delete this generation's owned resources</option></select></div>
          <label className="field"><span>Reason</span><textarea name="reason" required maxLength={500} disabled={busy} /></label>
          <label className="field"><span>For cleanup, type DESTROY</span><input name="confirmation" autoComplete="off" disabled={busy} /></label>
          <Button type="submit" disabled={busy}>Submit for exact approval checks</Button>
        </form></details> : null}
      </li>)}</ul>
    </section> : null}
    {content ? <section className="panel"><h2>Version {selected.plan.version} · {content.status.replaceAll("_", " ")}</h2>
      <p>Action: {content.deploymentAction || "deploy"}{content.lifecycle ? ` · retained operation ${content.lifecycle.targetOperationId}` : ""}</p>
      <p>Account {content.ownership.accountId} · {content.ownership.region} · {profiles[content.selectedProfile]}</p><p className="mono" style={{ overflowWrap: "anywhere" }}>Source SHA: {content.repository.sourceSha}</p>
      <p className="mono" style={{ overflowWrap: "anywhere" }}>Plan fingerprint: {selected.plan.fingerprint}</p>
      {content.infrastructure ? <p>Customer network: {content.infrastructure.vpcId} · {content.infrastructure.publicSubnetIds.join(", ")} · state bucket {content.infrastructure.terraformStateBucket}</p> : null}
      <h3>Services and configuration</h3><ul>{content.services.map((service) => <li key={service.id}>{service.name} · {service.directory} · port {service.port}</li>)}</ul>
      <p>{content.environmentReferences.length} service configuration references. Secret values are excluded.</p>
      {content.dependencies?.services?.length ? <><h3>Detected dependencies</h3><ul>{content.dependencies?.services.map((item) => <li key={`${item.kind}:${item.name}`}>{item.name} · {dependencyKinds[item.kind]} · {item.provisioning === "deployguard_attachment" ? "attached by DeployGuard" : item.provisioning === "missing" ? "configuration missing" : "supplied by you"} <span className="mono">({item.keys.join(", ") || "attachment"})</span></li>)}</ul></> : null}
      {content.blockers.length ? <Callout title="Approval blocked" tone="warning"><ul>{content.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></Callout> : null}
      <h3>Hosting comparison</h3>{content.comparison.recommendation ? <Callout title={content.comparison.recommendedProfile ? `Lowest-cost eligible option: ${profiles[content.comparison.recommendedProfile]}` : "No eligible hosting profile"}><p>{content.comparison.recommendation.summary.replace(content.comparison.recommendedProfile || "\u0000", profiles[content.comparison.recommendedProfile] || "")}</p>{content.comparison.recommendation.alternatives.length ? <ul>{content.comparison.recommendation.alternatives.map((item) => <li key={item.profile}>{profiles[item.profile]}: {item.advantage}</li>)}</ul> : null}</Callout> : null}{content.comparison.options.map((option) => <details className="disclosure" key={option.id}><summary>{profiles[option.id]} · {option.cost.monthlyUsd === null ? "Incomplete estimate" : `${option.cost.monthlyUsd.toFixed(2)} USD/month`} · {option.eligible ? "Eligible" : "Unavailable or blocked"}</summary><ul>{option.reasons.map((reason) => <li key={reason}>{reason}</li>)}{(option.warnings || []).map((warning) => <li key={warning}>Note: {warning}</li>)}</ul><dl>{option.cost.items.map((item, index) => <div key={`${item.category}-${index}`}><dt>{item.category.replaceAll("_", " ")}</dt><dd>{item.monthlyUsd === null ? "Unknown" : `${item.monthlyUsd.toFixed(2)} USD/month`} · {item.kind} · {item.reason}</dd></div>)}</dl></details>)}
      {content.selectedProfile !== "ecs_fargate" ? <>
        <h3>Provider infrastructure artifacts</h3>
        {artifacts?.planId === selected.plan.id ? <><p className="mono" style={{ overflowWrap: "anywhere" }}>Artifact fingerprint: {artifacts.manifest.artifactFingerprint}</p>
          <p>Terraform AWS provider {artifacts.manifest.providerVersion} · state key {artifacts.manifest.stateKey}</p>
          <details className="disclosure"><summary>{artifacts.manifest.ownedResourceAddresses.length} owned resources</summary><ul>{artifacts.manifest.ownedResourceAddresses.map((address) => <li key={address} className="mono">{address}</li>)}</ul></details>
          <p>Rollback keeps the previous generation until the new one verifies. Cleanup never deletes databases, secrets or shared networking.</p></>
          : <Button disabled={busy} onClick={() => void action(async (current) => { const result = await getProviderArtifacts(projectId, selected.plan.id); if (current === generation.current) setArtifacts({ planId: selected.plan.id, manifest: result.artifacts.manifest }); })}>Preview infrastructure artifacts</Button>}
      </> : null}
      <h3>Risks and security evidence</h3><ul>{[...content.risks, ...content.securityFindings.map((finding) => finding.reason)].map((risk) => <li key={risk}>{risk}</li>)}</ul>
      {selected.decision ? <><p role="status">Decision: {selected.decision.decision}</p>{canManage && selected.decision.decision === "approved" ? <Button disabled={busy || content.blockers.length > 0 || !content.comparison.options.find((option) => option.id === content.selectedProfile)?.eligible} onClick={() => void action(async () => { const result = await executeDeploymentPlan(projectId, selected.plan.id, selected.plan.fingerprint); if (result.deployment?.state === "accepted" || result.deployment?.state === "no_op") navigate(`/projects/${projectId}`); else if (result.status === "verified") { setNotice(`${profiles[content.selectedProfile]} generation verified. Job ${result.jobId}.`); setProviderHistory(await listProviderGenerations(projectId)); } else throw new Error(result.deployment?.message || "Deployment could not start."); })}>Execute this approved plan</Button> : null}</> : selected.canApprove ? <div className="actions"><Button disabled={busy || content.status !== "review_required" || content.blockers.length > 0} onClick={() => decide("approved")}>Approve this plan</Button><Button disabled={busy} onClick={() => decide("rejected")}>Reject this plan</Button></div> : null}
    </section> : null}
  </div>;
}
