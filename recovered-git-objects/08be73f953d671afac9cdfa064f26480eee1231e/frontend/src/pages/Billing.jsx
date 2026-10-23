import { useCallback, useEffect, useState } from "react";
import { cancelBilling, createBillingCheckout, createBillingPortal, getBillingSummary } from "../api/platformApi.js";
import EmptyState from "../components/common/EmptyState.jsx";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { PageHeader, StatusBadge } from "../components/common/Premium.jsx";

const meteredResources = [
  ["AI analyses", "ai_analysis", "aiAnalysesPerMonth"],
  ["AI follow-ups", "ai_followup", "aiFollowupsPerMonth"],
  ["Notifications", "notification", "notificationsPerMonth"],
  ["Terraform exports", "terraform_export", "terraformExportsPerMonth"],
];

export default function Billing() {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      setSummary(await getBillingSummary());
    } catch (caught) {
      setError(caught.message || "Plan and usage could not be loaded.");
    }
  }, []);

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
      <UsageItem enforced={enforcementEnabled} label="Active runs" used={workspace.activeRuns ?? 0} limit={null} />
      <UsageItem enforced={enforcementEnabled} label="Deployment runs this month" used={workspace.deploymentRuns ?? 0} limit={workspace.limits?.deploymentRuns} />
    </div></section>

    <section className="panel-flat"><div className="compact-section-heading"><div><p className="eyebrow">Resource limits</p><h2>Current billing period</h2></div></div><div className="billing-usage-grid">
      {meteredResources.map(([label, key, limitKey]) => <UsageItem enforced={enforcementEnabled} key={key} label={label} used={usage[key] || 0} limit={limits[limitKey]} />)}
    </div></section>

    <section className="panel-flat"><p className="eyebrow">Payment & invoices</p><h2>{summary.paymentMethod ? `${summary.paymentMethod.brand || "Card"} ending ${summary.paymentMethod.last4}` : "No payment method available"}</h2>{summary.invoices?.length ? <div className="session-list">{summary.invoices.map((invoice) => <a className="subtle-button" href={invoice.hostedInvoiceUrl || invoice.invoicePdfUrl} key={invoice.id} rel="noreferrer" target="_blank">{invoice.status} · {(invoice.amountDue / 100).toFixed(2)} {String(invoice.currency).toUpperCase()}</a>)}</div> : <EmptyState message="No provider invoices are available." />}</section>
  </div>;
}

function UsageItem({ enforced, label, used, limit }) {
  return <div><span>{label}</span><strong>{used} <small>/ {enforced ? (limit == null ? "No configured limit" : limit) : "Not enforced"}</small></strong></div>;
}
