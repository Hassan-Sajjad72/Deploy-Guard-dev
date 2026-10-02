import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { cleanupSafeOrphans, cleanupSelectedCloudResources, createCentralCleanupChallenge, createEmergencyCleanupChallenge, downloadCloudCleanupReport, executeEmergencyCleanup, getCloudCleanupResources, getCloudCleanupSummary, getEmergencyCleanupOperations, getEmergencyCleanupPreview, markCloudResourcesManualReview, markProjectCleanupComplete, refreshCloudCleanupInventory, retryCentralProjectDestroy } from "../api/adminApi.js";
import { requestDestroy } from "../api/platformApi.js";
import { refreshProjectResources } from "../api/platformApi.js";
import { ActionMenu, Button, Callout, ConfirmPhraseDialog, DataTable, Disclosure, EmptyState, PageHeader, Status } from "../components/common/DesignSystem.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import Time from "../components/common/Time.jsx";

const emptyFilters = { projectId: "", resourceType: "", status: "", risk: "", region: "", eligibility: "" };
const labels = { active: "Active", orphan: "Orphan", cleanup_required: "Cleanup required", protected: "Protected", deleted: "Deleted", manual_review: "Manual review" };
const inventoryTabs = [["all", "All"], ["high_cost", "High cost"], ["safe", "Safe to clean"], ["manual", "Manual review"], ["protected", "Protected"], ["errors", "Scan errors"], ["deleted", "Deleted"]];
const RISK_TONE = { high: "danger", medium: "warning", low: "neutral", none: "neutral" };
const STATUS_TONE = { orphan: "warning", cleanup_required: "danger", protected: "neutral", deleted: "neutral", manual_review: "warning", active: "success" };

export default function AdminCloudCleanup() {
  const [dashboard, setDashboard] = useState(null);
  const [resources, setResources] = useState([]);
  const [resourceGroups, setResourceGroups] = useState([]);
  const [emergencyPreview, setEmergencyPreview] = useState(null);
  const [emergencyOperations, setEmergencyOperations] = useState([]);
  const [emergencyConfirmation, setEmergencyConfirmation] = useState(null);
  const [filters, setFilters] = useState(emptyFilters);
  const [selected, setSelected] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [authUnavailable, setAuthUnavailable] = useState(false);
  const [notice, setNotice] = useState("");
  const [confirmation, setConfirmation] = useState(null);
  const [destroyConfirmation, setDestroyConfirmation] = useState(null);
  const [activeTab, setActiveTab] = useState("all");

  async function load(nextFilters = filters) {
    setError(""); setLoading(true);
    try { const [summary, inventory, emergency, operations] = await Promise.all([getCloudCleanupSummary(), getCloudCleanupResources(nextFilters), getEmergencyCleanupPreview(), getEmergencyCleanupOperations()]); setDashboard(summary); setResources(inventory.resources || []); setResourceGroups(inventory.groups || []); setEmergencyPreview(emergency); setEmergencyOperations(operations || []); setSelected([]); setAuthUnavailable(false); }
    catch (caught) { if ([401, 403].includes(caught.status)) { setAuthUnavailable(true); setError(""); } else setError(caught.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(emptyFilters); }, []);
  useEffect(() => { const timer = window.setTimeout(() => void load(filters), 180); return () => window.clearTimeout(timer); }, [filters.projectId, filters.resourceType, filters.status, filters.risk, filters.region, filters.eligibility]);
  useEffect(() => {
    if (!emergencyOperations.some((operation) => ["queued", "running", "waiting_for_project_cleanup"].includes(operation.status))) return undefined;
    const timer = window.setInterval(() => getEmergencyCleanupOperations().then(setEmergencyOperations).catch(() => undefined), 4000);
    return () => window.clearInterval(timer);
  }, [emergencyOperations]);

  const safeSelected = useMemo(() => resources.filter((resource) => selected.includes(resource.id) && resource.safeToCleanup && !resource.protected), [resources, selected]);
  const manualResources = resources.filter((resource) => resource.status === "manual_review");
  const summary = dashboard?.summary || {};

  async function refresh() { setBusy("refresh"); setError(""); setNotice(""); try { const response = await refreshCloudCleanupInventory(); setNotice(response.warnings?.length ? `Scan finished with ${response.warnings.length} warning(s). Anything that could not be verified stays protected.` : "AWS inventory refreshed."); await load(filters); } catch (caught) { setError(caught.message); } finally { setBusy(""); } }
  async function beginCleanup(action) { setBusy(action); setError(""); try { setConfirmation({ action, challenge: await createCentralCleanupChallenge(action) }); } catch (caught) { setError(caught.message); } finally { setBusy(""); } }
  async function executeCleanup(phrase) { if (!confirmation || phrase !== confirmation.challenge.confirmationPhrase) return; setBusy("cleanup"); setError(""); try { const body = { challengeId: confirmation.challenge.challengeId, challengeToken: confirmation.challenge.challengeToken, confirmationPhrase: phrase, ...(confirmation.action === "selected" ? { resourceIds: safeSelected.map((resource) => resource.id) } : {}) }; const response = confirmation.action === "selected" ? await cleanupSelectedCloudResources(body) : await cleanupSafeOrphans(body); const failed = response.results?.filter((result) => result.status === "failed").length || 0; setNotice(failed ? `Cleanup finished with ${failed} failure(s). Check the resource list.` : "Cleanup finished and the inventory was refreshed."); setConfirmation(null); await load(filters); } catch (caught) { setError(caught.message); } finally { setBusy(""); } }
  async function markManual() { if (!selected.length) return; setBusy("manual"); setError(""); try { await markCloudResourcesManualReview(selected); setNotice("Selected resources marked for manual review."); await load(filters); } catch (caught) { setError(caught.message); } finally { setBusy(""); } }
  async function exportReport() { setBusy("export"); setError(""); try { await downloadCloudCleanupReport(); setNotice("Cleanup report downloaded."); } catch (caught) { setError(caught.message); } finally { setBusy(""); } }
  async function prepareRetry(project) { setBusy(`retry-${project.id}`); setError(""); try { const challenge = await retryCentralProjectDestroy(project.id, project.latestDestroy.id); setDestroyConfirmation({ project, challenge }); } catch (caught) { setError(caught.message); } finally { setBusy(""); } }
  async function refreshProject(project) { setBusy(`scan-${project.id}`); setError(""); try { const result = await refreshProjectResources(project.id); setNotice(result.scan?.errors?.length ? `${project.name}: scan finished with errors.` : `${project.name}: inventory refreshed.`); await load(filters); } catch (caught) { setError(caught.message); } finally { setBusy(""); } }
  async function completeProject(project) { setBusy(`complete-${project.id}`); setError(""); try { await markProjectCleanupComplete(project.id); setNotice(`${project.name}: cleanup marked complete from verified inventory.`); await load(filters); } catch (caught) { setError(caught.message); } finally { setBusy(""); } }
  async function executeRetry(phrase) { if (!destroyConfirmation || phrase !== "DESTROY") return; setBusy("retry-destroy"); setError(""); try { const { project, challenge } = destroyConfirmation; await requestDestroy(project.id, { challengeId: challenge.challengeId, challengeToken: challenge.challengeToken, confirmationPhrase: phrase, environmentName: challenge.environmentName || project.latestDestroy.environmentName || "dev" }); setNotice(`Destroy retry queued for ${project.name}.`); setDestroyConfirmation(null); await load(filters); } catch (caught) { setError(caught.message); } finally { setBusy(""); } }
  async function beginEmergency() { setBusy("emergency-challenge"); setError(""); try { setEmergencyConfirmation(await createEmergencyCleanupChallenge()); } catch (caught) { setError(caught.message); } finally { setBusy(""); } }
  async function runEmergency(phrase) { if (!emergencyConfirmation || phrase !== "DESTROY ALL DEPLOYGUARD TEST RESOURCES") return; setBusy("emergency"); setError(""); try { await executeEmergencyCleanup({ challengeId: emergencyConfirmation.challengeId, challengeToken: emergencyConfirmation.challengeToken, confirmationPhrase: phrase }); setEmergencyConfirmation(null); setNotice("Emergency cleanup queued. Project destroys run first, then verified leftover resources are removed."); await load(filters); } catch (caught) { setError(caught.message); } finally { setBusy(""); } }
  function toggle(id) { setSelected((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]); }
  function chooseTab(value) {
    setActiveTab(value);
    const next = { all: { status: "", risk: "", eligibility: "" }, high_cost: { status: "", risk: "high", eligibility: "" }, safe: { status: "", risk: "", eligibility: "safe" }, manual: { status: "", risk: "", eligibility: "manual" }, protected: { status: "", risk: "", eligibility: "protected" }, deleted: { status: "deleted", risk: "", eligibility: "" } }[value];
    if (next) setFilters({ ...filters, ...next });
  }

  const header = <PageHeader actions={!authUnavailable ? <><Button disabled={Boolean(busy)} icon="deploy" onClick={exportReport} tone="ghost">Export report</Button><Button aria-busy={busy === "refresh" || undefined} disabled={Boolean(busy)} icon="refresh" onClick={refresh}>{busy === "refresh" ? "Scanning AWS…" : "Scan AWS"}</Button></> : null} description={`Find and remove leftover DeployGuard resources in ${summary.region || "the configured region"}. Shared platform resources, such as the Terraform state bucket, are always protected.`} title="Cloud cleanup" />;

  if (authUnavailable) return <div className="page admin-page">{header}<Callout actions={<><Link className="btn btn-primary btn-sm" to="/admin/login">Sign in again</Link><Button onClick={() => void load(filters)} size="sm" tone="ghost">Try again</Button></>} title="Your admin session has expired" tone="warning"><p>The cloud inventory could not be loaded. No counts are shown, so nothing here should be read as “clean”.</p></Callout></div>;

  return <div className="page admin-page cleanup-page">
    {header}
    {error ? <ErrorState message={error} title="The cleanup action did not complete" /> : null}
    {notice ? <Callout tone="success">{notice}</Callout> : null}
    {loading && !dashboard ? <LoadingState inline message="Loading the cloud inventory…" /> : null}

    {dashboard ? <>
      {dashboard.latestScan ? <p className="muted cleanup-scan">Last scan {dashboard.latestScan.status === "completed" ? "completed" : String(dashboard.latestScan.status).replaceAll("_", " ")} <Time value={dashboard.latestScan.completedAt} /> · {dashboard.latestScan.resourceCount} resources across {dashboard.latestScan.servicesChecked.length} AWS services</p> : <Callout title="No account scan yet" tone="warning"><p>Run a scan before drawing any cleanup conclusions.</p></Callout>}
      {dashboard?.latestScan?.errors?.length ? <Callout title="Some AWS services could not be checked" tone="warning"><p>Resources in these services stay protected from automatic cleanup.</p><ul className="cleanup-errors">{dashboard.latestScan.errors.map((item) => <li className="mono" key={item}>{item}</li>)}</ul></Callout> : null}

      <p className="admin-totals"><strong className={`num${summary.cleanupRequiredProjects ? " is-bad" : ""}`}>{summary.cleanupRequiredProjects ?? 0}</strong> {summary.cleanupRequiredProjects === 1 ? "project needs" : "projects need"} cleanup · <strong className={`num${summary.highCostRiskResources ? " is-bad" : ""}`}>{summary.highCostRiskResources ?? 0}</strong> high cost-risk resource{summary.highCostRiskResources === 1 ? "" : "s"} · <strong className="num">{summary.manualReviewResources ?? 0}</strong> for manual review across the account · <strong className={`num${summary.inventoryErrors ? " is-bad" : ""}`}>{summary.inventoryErrors ?? 0}</strong> scan error{summary.inventoryErrors === 1 ? "" : "s"}</p>
      <section aria-labelledby="cleanup-projects" className="section">
        <div className="section-head"><h2 id="cleanup-projects">Projects</h2><p>Infrastructure state and verified leftover resources are tracked separately.</p></div>
        {dashboard.projects?.length ? <DataTable caption="Project cleanup status" label="Project cleanup status"><thead><tr><th>Project</th><th>Deployment</th><th>Resources</th><th>Cleanup</th><th>Next step</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{dashboard.projects.map((project) => <tr key={project.id}>
          <td data-label="Project"><strong>{project.name}</strong><span className="cell-sub">{project.repositoryFullName || project.id}</span></td>
          <td data-label="Deployment">{human(project.deploymentStatus)}<span className="cell-sub">{human(project.healthStatus)} · {human(project.cloudVerificationStatus)}</span></td>
          <td data-label="Resources">{project.resourceCount} found{project.highCostCount ? <span className="cell-sub cleanup-risk">{project.highCostCount} high cost</span> : null}</td>
          <td data-label="Cleanup"><Status tone={project.cleanupStatus === "cleanup_required" ? "danger" : project.cleanupStatus === "not_required" ? "success" : "neutral"}>{human(project.cleanupStatus)}</Status>{project.manualReviewCount ? <span className="cell-sub">{project.manualReviewCount} for manual review</span> : null}</td>
          <td data-label="Next step">{human(project.nextAction)}<span className="cell-sub">{project.statusExplanation}</span></td>
          <td className="cell-end" data-label=""><ActionMenu items={[
            { label: "Show its resources", onSelect: () => { setFilters({ ...emptyFilters, projectId: project.id }); document.getElementById("cleanup-resources")?.scrollIntoView({ behavior: "smooth" }); } },
            { label: busy === `scan-${project.id}` ? "Scanning…" : "Rescan this project", disabled: Boolean(busy), onSelect: () => refreshProject(project) },
            { label: "Open project settings", to: `/projects/${project.id}/settings` },
            project.latestDestroy?.status === "failed" ? { label: "Retry destroy…", danger: true, disabled: Boolean(busy), onSelect: () => prepareRetry(project) } : null,
            project.canMarkCleanupComplete ? { label: "Mark cleanup complete", disabled: Boolean(busy), onSelect: () => completeProject(project) } : null,
          ]} label={`Actions for ${project.name}`} /></td>
        </tr>)}</tbody></DataTable> : <EmptyState compact message="No projects have cloud resources on record." title="No projects" />}
      </section>

      <section aria-labelledby="cleanup-resources-title" className="section" id="cleanup-resources">
        <div className="section-head"><h2 id="cleanup-resources-title">Leftover resources</h2><div className="actions"><Button disabled={!summary.safeOrphanResources || Boolean(busy)} onClick={() => beginCleanup("safe_orphans")} tone="danger">Clean all safe orphans{summary.safeOrphanResources ? ` (${summary.safeOrphanResources})` : ""}</Button></div></div>
        {resourceGroups.length ? <ul className="rows cleanup-groups">{resourceGroups.map((group) => {
          const direct = [...group.directCleanup.ecrRepositories, ...group.directCleanup.logs, ...group.directCleanup.secrets, ...group.directCleanup.oldTaskDefinitions];
          return <li key={group.projectId || "unmapped"}><details className="cleanup-group">
            <summary><span><strong>{group.projectName}</strong><small className="mono">{group.projectId || "Ownership not mapped"}</small></span><span className="cleanup-group-counts"><span>{group.terraformStack.length} Terraform</span><span>{direct.length} direct</span><span className={group.manualReview.length ? "is-warn" : ""}>{group.manualReview.length} manual</span><span>{group.protected.length} protected</span></span></summary>
            <div className="cleanup-paths">{[["Removed by Terraform destroy", group.terraformStack], ["Removed directly", direct], ["Needs manual review", group.manualReview], ["Protected", group.protected]].map(([title, items]) => <div key={title}><h3>{title}<span className="count">{items.length}</span></h3>{items.length ? <ul>{items.slice(0, 6).map((item) => <li className="mono" key={item.id}>{item.name}{item.children?.length ? <span className="muted"> +{item.children.length}</span> : null}</li>)}{items.length > 6 ? <li className="muted">and {items.length - 6} more</li> : null}</ul> : <p className="muted">None</p>}</div>)}</div>
          </details></li>;
        })}</ul> : <p className="muted">No leftover resources are grouped for cleanup.</p>}

        <Disclosure summary="Every resource, with filters">
          <div aria-label="Resource view" className="segmented" role="group">{inventoryTabs.map(([value, text]) => <button aria-pressed={activeTab === value} key={value} onClick={() => chooseTab(value)} type="button">{text}</button>)}</div>
          {activeTab !== "errors" ? <>
            <div className="cleanup-filters">
              <select aria-label="Project filter" className="select" onChange={(event) => setFilters({ ...filters, projectId: event.target.value })} value={filters.projectId}><option value="">All projects</option>{(dashboard?.projects || []).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
              <select aria-label="Resource type filter" className="select" onChange={(event) => setFilters({ ...filters, resourceType: event.target.value })} value={filters.resourceType}><option value="">All types</option>{unique(resources.map((resource) => resource.type)).map((value) => <option key={value} value={value}>{human(value)}</option>)}</select>
              <select aria-label="Status filter" className="select" onChange={(event) => setFilters({ ...filters, status: event.target.value })} value={filters.status}><option value="">All statuses</option>{Object.entries(labels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select>
              <select aria-label="Risk filter" className="select" onChange={(event) => setFilters({ ...filters, risk: event.target.value })} value={filters.risk}><option value="">All cost risk</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option><option value="none">None</option></select>
              <select aria-label="Region filter" className="select" onChange={(event) => setFilters({ ...filters, region: event.target.value })} value={filters.region}><option value="">All regions</option>{unique(resources.map((resource) => resource.region)).map((value) => <option key={value} value={value}>{value}</option>)}</select>
            </div>
            {resources.length ? <DataTable caption="Cloud resources" label="Cloud resources" stack={false}><thead><tr><th><span className="sr-only">Select</span></th><th>Resource</th><th>Project</th><th>Status</th><th>Cost risk</th><th>Cleanup path</th><th>Last seen</th></tr></thead><tbody>{resources.map((resource) => <tr className={resource.costRisk === "high" ? "high-cost-row" : ""} key={resource.id}>
              <td><input aria-label={`Select ${resource.name}`} checked={selected.includes(resource.id)} disabled={!resource.safeToCleanup || resource.protected || resource.status === "deleted"} onChange={() => toggle(resource.id)} type="checkbox" /></td>
              <td><span className="mono">{resource.name}</span><span className="cell-sub">{human(resource.type)} · {resource.awsService} · {resource.region}</span>{resource.reason ? <span className="cell-sub">{resource.reason}</span> : null}</td>
              <td>{resource.projectName || (resource.projectId ? "Known project" : "Unmapped")}{resource.pipelineRunId ? <span className="cell-sub mono">run {resource.pipelineRunId.slice(0, 8)}</span> : null}</td>
              <td><Status tone={STATUS_TONE[resource.status] || "neutral"}>{labels[resource.status] || human(resource.status)}</Status></td>
              <td><Status tone={RISK_TONE[resource.costRisk] || "neutral"}>{human(resource.costRisk)}</Status></td>
              <td>{human(resource.cleanupEligibility)}<span className="cell-sub">{human(resource.ownership)}</span></td>
              <td>{resource.lastSeen ? <Time value={resource.lastSeen} /> : "—"}</td>
            </tr>)}</tbody></DataTable> : !loading ? <EmptyState compact message="Nothing matches these filters. Scan AWS to refresh the inventory." title="No resources" /> : null}
            <div className="cleanup-selection"><span className="muted">{selected.length} selected · {safeSelected.length} safe to clean</span><div className="actions"><Button disabled={!selected.length || Boolean(busy)} onClick={markManual} size="sm" tone="ghost">Mark for manual review</Button><Button disabled={!safeSelected.length || Boolean(busy)} onClick={() => beginCleanup("selected")} size="sm" tone="danger">Clean selected</Button></div></div>
          </> : dashboard?.latestScan?.errors?.length ? <ul className="cleanup-errors">{dashboard.latestScan.errors.map((item) => <li className="mono" key={item}>{item}</li>)}</ul> : <p className="muted">The last scan recorded no errors.</p>}
        </Disclosure>
      </section>

      {manualResources.length ? <section aria-labelledby="cleanup-manual" className="section">
        <div className="section-head"><h2 id="cleanup-manual">Needs manual review<span className="count">{manualResources.length} in this view</span></h2><p>Load balancers, networks, file systems and IAM resources DeployGuard is not certain about are never deleted automatically.</p></div>
        <ul className="rows cleanup-manual">{manualResources.slice(0, 12).map((resource) => <li key={resource.id}><span className="mono">{resource.name}</span><span className="muted">{human(resource.type)} · {resource.reason}</span></li>)}</ul>
      </section> : null}

      <section aria-labelledby="cleanup-jobs" className="section">
        <div className="section-head"><h2 id="cleanup-jobs">Recent cleanup jobs</h2></div>
        {(dashboard?.cleanupOperations || []).length ? <ul className="rows cleanup-jobs">{dashboard.cleanupOperations.slice(0, 5).map((operation) => <li key={`${operation.kind}-${operation.id}`}><span>{human(operation.kind)}</span><Status tone={/fail/.test(operation.cleanupStatus || operation.status) ? "danger" : /complete|verified/.test(operation.cleanupStatus || operation.status) ? "success" : "info"}>{human(operation.cleanupStatus || operation.status)}</Status></li>)}</ul> : <p className="muted">No cleanup jobs have run yet.</p>}
        {emergencyOperations[0] ? <Disclosure summary="Latest emergency cleanup progress"><ul className="rows cleanup-jobs">{emergencyOperations[0].targets.map((target) => <li key={target.projectId}><span>{target.projectName}</span><span>{human(target.status)}</span></li>)}</ul></Disclosure> : null}
      </section>

      <section aria-labelledby="cleanup-danger" className="section">
        <div className="section-head"><h2 id="cleanup-danger">Danger zone</h2></div>
        <div className="panel danger-zone"><div className="danger-row"><div><h3>Destroy all testing and preview resources</h3><p>{emergencyPreview?.targetCount || 0} eligible project environment{emergencyPreview?.targetCount === 1 ? "" : "s"} and {emergencyPreview?.resourceCount || 0} tagged resources. Production and shared resources are excluded by design. Use only for non-production recovery.</p></div><Button disabled={Boolean(busy) || !emergencyPreview?.targetCount} onClick={beginEmergency} tone="danger">Destroy testing resources…</Button></div></div>
      </section>
    </> : null}

    {confirmation ? <ConfirmPhraseDialog busy={busy === "cleanup"} busyLabel="Cleaning…" confirmLabel="Clean up" id="cleanup-confirm" onClose={() => setConfirmation(null)} onConfirm={(phrase) => void executeCleanup(phrase)} phrase={confirmation.challenge.confirmationPhrase} title={confirmation.action === "selected" ? `Clean up ${safeSelected.length} selected resource${safeSelected.length === 1 ? "" : "s"}?` : "Clean up all safe orphans?"}><p>Only resources DeployGuard has verified as its own, with a supported removal path, are touched. Shared platform resources stay protected.</p></ConfirmPhraseDialog> : null}
    {destroyConfirmation ? <ConfirmPhraseDialog busy={busy === "retry-destroy"} busyLabel="Queueing…" confirmLabel="Retry destroy" id="cleanup-retry" onClose={() => setDestroyConfirmation(null)} onConfirm={(phrase) => void executeRetry(phrase)} phrase="DESTROY" title={`Retry destroy for ${destroyConfirmation.project.name}?`}><p>Terraform destroy runs again for this project only. The shared state bucket and platform resources remain protected.</p></ConfirmPhraseDialog> : null}
    {emergencyConfirmation ? <ConfirmPhraseDialog busy={busy === "emergency"} busyLabel="Queueing…" confirmLabel="Queue emergency cleanup" id="cleanup-emergency" onClose={() => setEmergencyConfirmation(null)} onConfirm={(phrase) => void runEmergency(phrase)} phrase="DESTROY ALL DEPLOYGUARD TEST RESOURCES" title="Destroy all testing and preview resources?"><p>Each eligible project's Terraform destroy runs first, then verified leftover resources are removed. Production, shared resources, state files, backups and the state bucket are excluded.</p></ConfirmPhraseDialog> : null}
  </div>;
}

function unique(values) { return [...new Set(values.filter(Boolean))].sort(); }
const ACRONYMS = { efs: "EFS", ecr: "ECR", ecs: "ECS", alb: "ALB", iam: "IAM", vpc: "VPC", nat: "NAT", eip: "EIP", s3: "S3", aws: "AWS", ttl: "TTL" };
function human(value) { const text = String(value || "—").replaceAll("_", " ").replace(/\b[a-z0-9]+\b/gi, (word) => ACRONYMS[word.toLowerCase()] || word); return text.charAt(0).toUpperCase() + text.slice(1); }
