import { useCallback, useEffect, useState } from "react";
import { cancelBilling, createBillingCheckout, createBillingPortal, getBillingSummary } from "../api/platformApi.js";
import { getWorkspaceSummary } from "../api/projectApi.js";
import EmptyState from "../components/common/EmptyState.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { PageHeader, StatusBadge } from "../components/common/Premium.jsx";
import { normalReleaseView } from "../utils/normalReleaseView.js";

const meteredResources = [
  ["AI analyses", "ai_analysis", "aiAnalysesPerMonth"],
  ["AI follow-ups", "ai_followup", "aiFollowupsPerMonth"],
  ["Notifications", "notification", "notificationsPerMonth"],
  ["Infrastructure exports", "terraform_export", "terraformExportsPerMonth"],
];

export default function Billing() {
  const [summary, setSummary] = useState(null);
  const [workspaceSummary, setWorkspaceSummary] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [historyFilters, setHistoryFilters] = useState({ state: "", project: "", from: "", to: "" });
  const [historyDraft, setHistoryDraft] = useState({ state: "", project: "", from: "", to: "" });
  const [historyCursor, setHistoryCursor] = useState(null);
  const [historyCursorStack, setHistoryCursorStack] = useState([]);

  const load = useCallback(async () => {
    setError("");
    try {
      const [billing, workspace] = await Promise.all([
        getBillingSummary(),
        getWorkspaceSummary({
          historyState: historyFilters.state,
          historyProject: historyFilters.project,
          historyFrom: toIso(historyFilters.from),
          historyTo: toIso(historyFilters.to),
          historyLimit: "5",
          historyCursor: historyCursor || "",
        }),
      ]);
      setSummary(billing);
      setWorkspaceSummary(workspace);
    } catch (caught) {
      setError(caught.message || "Plan and usage could not be loaded.");
    }
  }, [historyCursor, historyFilters]);

  useEffect(() => { void load(); }, [load]);

  async function act(work) {
    setBusy(true);
    setError("");
    try {
      const value = await work();
      if (value?.checkoutUrl) window.location.assign(value.checkoutUrl);
      else if (value?.url) window.location.assign(value.url);
      else await load();
    } catch (caught) {
      setError(caught.message || "The billing action failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!summary) return <div className="workspace-page">{error ? <ErrorState message={error} onRetry={load} /> : <LoadingState message="Loading plan and usage…" />}</div>;

  const limits = summary.entitlements || {};
  const usage = summary.usage || {};
  const workspace = summary.workspaceUsage || {};
  const releaseSummary = workspaceSummary?.releaseSummary || {};
  const releaseHistory = Array.isArray(workspaceSummary?.releaseHistory) ? workspaceSummary.releaseHistory : [];
  const currentReleases = (workspaceSummary?.summaries || [])
    .map(({ project, currentState }) => ({ project, release: normalReleaseView(currentState) }))
    .filter(({ release }) => Boolean(release))
    .slice(0, 5);
  const historyPage = workspaceSummary?.releaseHistoryPage || {};
  const configured = summary.provider?.configured === true;
  const enforcementEnabled = summary.enforcement?.enabled !== false;
  const planName = summary.plan === "pro" ? "Pro" : "Free";

  return <div className="workspace-page">
    <PageHeader eyebrow="Workspace" title="Plan & usage" description="Review your persisted plan, project capacity, and real platform usage." />
    {error ? <ErrorState message={error} onRetry={load} /> : null}
    {!enforcementEnabled ? <section className="panel-flat state info" role="status"><div><strong>Usage enforcement is disabled for testing.</strong><p>Plan limits remain visible for reference, but they do not block project creation, deployment runs, or metered platform actions.</p></div></section> : null}

    <section className="panel-flat billing-plan-card">
      <div><p className="eyebrow">Current plan</p><h2>{planName}</h2><p>Plan status: {summary.status || "unknown"}</p></div>
      <StatusBadge status={summary.status || "unknown"} />
      <div className="quick-actions">
        {configured && summary.plan === "free" ? <button className="button" disabled={busy} onClick={() => act(createBillingCheckout)} type="button">Upgrade to Pro</button> : null}
        {configured && summary.plan === "pro" ? <button className="secondary-button" disabled={busy} onClick={() => act(createBillingPortal)} type="button">Manage plan</button> : null}
        {configured && summary.plan === "pro" ? <button className="secondary-button" disabled={busy} onClick={() => act(cancelBilling)} type="button">Cancel plan</button> : null}
      </div>
    </section>

    {!configured ? <section className="panel-flat"><p className="eyebrow">Payments</p><h2>Payment integration not configured</h2><p className="muted">Free-plan usage remains available. Upgrade and plan-management actions are disabled until the server payment provider is configured.</p></section> : null}

    <section className="panel-flat"><div className="compact-section-heading"><div><p className="eyebrow">Workspace usage</p><h2>Projects and deployment runs</h2></div></div><div className="billing-usage-grid">
      <UsageItem enforced={enforcementEnabled} label="Active projects" used={workspace.activeProjects ?? 0} limit={workspace.limits?.activeProjects ?? limits.activeProjects} />
      <UsageItem enforced={enforcementEnabled} label="Active runs" used={workspaceSummary?.usage?.activeRuns ?? workspace.activeRuns ?? 0} limit={null} />
      <UsageItem enforced={enforcementEnabled} label="Deployment runs this month" used={workspace.deploymentRuns ?? 0} limit={workspace.limits?.deploymentRuns} />
    </div></section>

    <section className="panel-flat"><div className="compact-section-heading"><div><p className="eyebrow">Deployments</p><h2>Workspace releases</h2></div></div><div className="billing-usage-grid">
      <UsageItem displayOnly label="Active releases" used={releaseSummary.activeV1Releases ?? 0} />
      <UsageItem displayOnly label="Completed releases" used={releaseSummary.completedV1Releases ?? 0} />
      <UsageItem displayOnly label="Blocked releases" used={releaseSummary.blockedOrFailedV1Releases ?? 0} />
      <UsageItem displayOnly label="Stable projects" used={releaseSummary.stableProjects ?? 0} />
      <UsageItem displayOnly label="Rollback lineage" used={releaseSummary.rollbackLineageProjects ?? 0} />
    </div></section>

    {currentReleases.length ? <section className="panel-flat" aria-label="Current canonical release state"><div className="compact-section-heading"><div><p className="eyebrow">Current state</p><h2>Latest attempted and stable releases</h2><p>These snapshots come from the same authoritative workspace response as Dashboard totals.</p></div></div><div className="session-list">{currentReleases.map(({ project, release }) => <div className="subtle-button" data-workspace-release={release.status} key={project.id}><strong>{project.name}</strong><span>{release.summary}</span><small>{release.stableRelease ? `Stable release ${release.stableRelease.revision}` : "No verified stable release"}</small></div>)}</div></section> : null}

    <section className="panel-flat"><div className="compact-section-heading"><div><p className="eyebrow">Release history</p><h2>Recent deployment outcomes</h2></div></div>
      <form className="billing-history-filters" onSubmit={(event) => { event.preventDefault(); setHistoryCursor(null); setHistoryCursorStack([]); setHistoryFilters(historyDraft); }}>
        <label><span>Project</span><input aria-label="Filter release history by project" maxLength="80" onChange={(event) => setHistoryDraft({ ...historyDraft, project: event.target.value })} value={historyDraft.project} /></label>
        <label><span>Terminal state</span><select aria-label="Filter release history by terminal state" onChange={(event) => setHistoryDraft({ ...historyDraft, state: event.target.value })} value={historyDraft.state}><option value="">All terminal states</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option><option value="blocked">Blocked</option></select></label>
        <label><span>From</span><input aria-label="Filter release history from" onChange={(event) => setHistoryDraft({ ...historyDraft, from: event.target.value })} type="datetime-local" value={historyDraft.from} /></label>
        <label><span>To</span><input aria-label="Filter release history to" onChange={(event) => setHistoryDraft({ ...historyDraft, to: event.target.value })} type="datetime-local" value={historyDraft.to} /></label>
        <div className="quick-actions"><button className="secondary-button" type="submit">Apply filters</button><button className="secondary-button" onClick={() => { const empty = { state: "", project: "", from: "", to: "" }; setHistoryDraft(empty); setHistoryFilters(empty); setHistoryCursor(null); setHistoryCursorStack([]); }} type="button">Clear</button></div>
      </form>
      {releaseHistory.length ? <div className="session-list">{releaseHistory.map((event) => <div className="subtle-button" key={`${event.projectName}:${event.occurredAt}`}><strong>{event.projectName}</strong><span>{event.terminalState} · release {event.candidateReleaseRevision || "—"} · {event.sourceCommitShortSha || "—"}</span><small>{new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(event.occurredAt))}</small></div>)}</div> : <EmptyState message="No recent deployment outcomes are available." />}
      <div className="quick-actions"><button className="secondary-button" disabled={!historyCursorStack.length} onClick={() => { const previous = historyCursorStack.at(-1) || null; setHistoryCursorStack(historyCursorStack.slice(0, -1)); setHistoryCursor(previous); }} type="button">Previous</button><button className="secondary-button" disabled={!historyPage.nextCursor} onClick={() => { setHistoryCursorStack([...historyCursorStack, historyCursor]); setHistoryCursor(historyPage.nextCursor); }} type="button">Next</button></div>
    </section>

    <section className="panel-flat"><div className="compact-section-heading"><div><p className="eyebrow">Resource limits</p><h2>Current billing period</h2></div></div><div className="billing-usage-grid">
      {meteredResources.map(([label, key, limitKey]) => <UsageItem enforced={enforcementEnabled} key={key} label={label} used={usage[key] || 0} limit={limits[limitKey]} />)}
    </div></section>

    <section className="panel-flat"><p className="eyebrow">Payment & invoices</p><h2>{summary.paymentMethod ? `${summary.paymentMethod.brand || "Card"} ending ${summary.paymentMethod.last4}` : "No payment method available"}</h2>{summary.invoices?.length ? <div className="session-list">{summary.invoices.map((invoice) => <a className="subtle-button" href={invoice.hostedInvoiceUrl || invoice.invoicePdfUrl} key={invoice.id} rel="noreferrer" target="_blank">{invoice.status} · {(invoice.amountDue / 100).toFixed(2)} {String(invoice.currency).toUpperCase()}</a>)}</div> : <EmptyState message="No provider invoices are available." />}</section>
  </div>;
}

function UsageItem({ enforced = false, label, used, limit, displayOnly = false }) {
  return <div><span>{label}</span><strong>{used}{displayOnly ? null : <small> / {enforced ? (limit == null ? "No configured limit" : limit) : "Not enforced"}</small>}</strong></div>;
}

function toIso(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}
