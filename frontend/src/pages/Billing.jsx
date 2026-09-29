import { useCallback, useEffect, useState } from "react";
import { createBillingCheckout, createBillingPortal, downloadBillingInvoice, getBillingInvoice, getBillingSummary } from "../api/platformApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import EmptyState from "../components/common/EmptyState.jsx";
import { Button, Card, PageHeader, StatusChip } from "../components/common/DesignSystem.jsx";
import { useAuth } from "../hooks/useAuth.js";
import "../styles/pages/billing.css";

const title = (plan) => String(plan || "FREE").replace("_", " ");
const dateTime = (value) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Not started";
const planCatalog = [
  { id: "free", name: "FREE", price: 0, detail: "Evaluate DeployGuard with a 48-hour LIVE trial after the first LIVE deployment." },
  { id: "pro", name: "PRO", price: 399, detail: "Stripe Test Mode subscription for continued LIVE capacity.", featured: true },
  { id: "pro_plus", name: "PRO PLUS", price: 799, detail: "Stripe Test Mode subscription with the highest workspace capacity." },
];
const money = (amount, currency = "USD") => `${(Number(amount || 0) / 100).toFixed(2)} ${String(currency).toUpperCase()}`;

export default function Billing() {
  const { user } = useAuth();
  const [summary, setSummary] = useState(null);
  const [invoice, setInvoice] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => { try { setSummary(await getBillingSummary()); setError(""); } catch (caught) { setError(caught.message || "Subscription details are unavailable."); } }, []);
  useEffect(() => { void load(); }, [load]);

  async function upgrade(plan) {
    setBusy(plan); setError("");
    try { const checkout = await createBillingCheckout(plan); window.location.assign(checkout.checkoutUrl); }
    catch (caught) { setError(caught.message || "Stripe Test Mode checkout could not be created."); setBusy(""); }
  }
  async function manageBilling() {
    setBusy("portal"); setError("");
    try { const portal = await createBillingPortal(); window.location.assign(portal.portalUrl); }
    catch (caught) { setError(caught.message || "Stripe Customer Portal could not be opened."); setBusy(""); }
  }
  async function viewInvoice(id) { setBusy(id); try { setInvoice(await getBillingInvoice(id)); } catch (caught) { setError(caught.message || "Invoice is unavailable."); } finally { setBusy(""); } }
  async function download(item) { setBusy(`pdf:${item.id}`); try { await downloadBillingInvoice(item); } catch (caught) { setError(caught.message || "Invoice download failed."); } finally { setBusy(""); } }

  if (!summary) return <div className="workspace-page">{error ? <ErrorState message={error} onRetry={load} /> : <LoadingState message="Loading subscription…" />}</div>;
  const usage = summary.workspaceUsage || {};
  const limits = usage.limits || {};
  const canUpgrade = ["admin", "developer"].includes(user?.role);
  const returned = new URLSearchParams(window.location.search).get("checkout") === "returned";
  const overLimit = usage.overLimit?.currentProjects || usage.overLimit?.liveProjects;
  const stripeConfigured = Boolean(summary.provider?.configured);
  const missingStripeConfiguration = summary.provider?.missingConfiguration || [];
  const checkoutAllowed = canUpgrade && summary.billing?.enabled && !summary.providerSubscriptionId && stripeConfigured;
  const planOffer = (id) => id === "pro" ? summary.plan === "free" : id === "pro_plus" ? summary.plan !== "pro_plus" : false;
  return <div className="workspace-page billing-page dg-billing" data-billing-mode={summary.billing?.mode || "disabled"}>
    <PageHeader description="Authoritative subscription, LIVE capacity, Stripe test payments, and invoices." eyebrow="Workspace" title="Plan & Usage" />
    {error ? <ErrorState message={error} onRetry={load} /> : null}
    <div className="dg-bill-notices">
      {!summary.billing?.enabled ? <Card><strong>Billing is disabled.</strong><p>DeployGuard preserves unrestricted project and deployment behavior.</p></Card> : null}
      {summary.billing?.enabled && !summary.enforcement?.enabled ? <Card className="state info" role="status"><strong>FYP observation mode</strong><p>Usage and limits are visible, but quota and trial expiry do not block deployments.</p></Card> : null}
      {summary.billing?.enabled && stripeConfigured ? <Card className="state info" role="status"><strong>Stripe Test Mode</strong><p>Checkout is test-only. A plan changes only after DeployGuard verifies Stripe’s signed webhook; no real charge is possible.</p></Card> : null}
      {summary.billing?.enabled && !stripeConfigured ? <Card className="state info" role="status"><strong>Stripe Test Mode is not configured</strong><p>Plan selection is unavailable until the local Stripe test configuration is complete. Missing: {missingStripeConfiguration.join(", ") || "required Stripe configuration"}. No Stripe checkout will be started.</p></Card> : null}
      {returned ? <Card className="state info" role="status"><strong>Payment verification pending</strong><p>Returning from checkout does not activate a plan. Refresh after the verified Stripe webhook arrives.</p><Button onClick={() => void load()}>Refresh status</Button></Card> : null}
      {overLimit ? <Card className="state danger" role="alert"><strong>OVER_LIMIT</strong><p>Existing projects remain untouched. New quota-consuming transitions are {summary.enforcement?.enabled ? "blocked until usage is compliant" : "allowed while observation mode is active"}.</p></Card> : null}
    </div>

    <section className="dg-bill-hero" aria-label="Current plan and usage">
      <Card className="billing-plan-card"><div><p className="eyebrow">Current plan</p><h2>{title(summary.planName)}</h2><p className="dg-bill-price"><strong>${summary.pricing?.monthlyUsd || 0}</strong> / month</p></div><div className="quick-actions"><StatusChip status={summary.status} tone={summary.status === "active" ? "success" : undefined}>{summary.status}</StatusChip>{canUpgrade && summary.customerPortalAvailable ? <Button disabled={Boolean(busy)} onClick={() => void manageBilling()}>{busy === "portal" ? "Opening…" : "Manage Billing"}</Button> : null}</div>
        {summary.plan === "free" ? <div className="dg-bill-period"><p className="eyebrow">Free LIVE trial</p><h3>{summary.trial?.expired ? "Expired" : summary.trial?.startedAt ? "Active" : "Available"}</h3><p>Started: {dateTime(summary.trial?.startedAt)} · Ends: {dateTime(summary.trial?.endsAt)} · Remaining: {summary.trial?.remainingSeconds == null ? "48 hours after first LIVE deployment" : `${Math.ceil(summary.trial.remainingSeconds / 3600)} hours`}</p></div> : <div className="dg-bill-period"><p className="eyebrow">Billing period</p><h3>{dateTime(summary.billingPeriodEnd)}</h3><p>Current Stripe Test Mode subscription period.</p></div>}
      </Card>
      <Card className="dg-bill-usage"><p className="eyebrow">Capacity</p><h2>Authoritative usage</h2><div className="billing-usage-grid"><Usage label="Current projects" used={usage.currentProjects ?? 0} limit={limits.currentProjects} over={usage.overLimit?.currentProjects} /><Usage label="LIVE projects" used={usage.liveProjects ?? 0} limit={limits.liveProjects} over={usage.overLimit?.liveProjects} /></div></Card>
    </section>

    <section aria-labelledby="billing-plans" className="dg-bill-plans">
      <div className="dg-bill-section-head"><p className="eyebrow">Upgrade</p><h2 id="billing-plans">Stripe Test Mode plans</h2></div>
      <div className="dg-bill-plan-grid">{planCatalog.map((plan) => <article className={`dg-bill-plan${plan.featured ? " is-featured" : ""}${summary.plan === plan.id ? " is-current" : ""}`} key={plan.id}>
        {plan.featured ? <span className="dg-bill-ribbon">Recommended</span> : null}
        <h3>{plan.name}</h3>
        <p className="dg-bill-plan-price"><strong>${plan.price}</strong> / month</p>
        <p>{plan.detail}</p>
        {summary.plan === plan.id ? <span className="dg-bill-current">Current plan</span> : checkoutAllowed && planOffer(plan.id) ? <Button disabled={Boolean(busy)} onClick={() => void upgrade(plan.id)}>{busy === plan.id ? "Opening…" : `Choose ${plan.name} · $${plan.price}/month`}</Button> : <span className="dg-bill-unavailable">{planOffer(plan.id) ? "Checkout unavailable" : "Not available from this plan"}</span>}
      </article>)}</div>
    </section>

    <Card className="dg-bill-invoices"><p className="eyebrow">Invoice history</p><h2>Verified payments</h2>{summary.invoices?.length ? <div className="session-list"><div aria-hidden="true" className="billing-invoice-head"><span>Invoice</span><span>Amount</span><span>Status</span><span /></div>{summary.invoices.map((item) => <div className="subtle-button billing-invoice-row" key={item.id}><div><strong>{item.invoiceNumber}</strong><small>{title(item.plan)} · {dateTime(item.paidAt)}</small></div><span>{money(item.amountDue, item.currency)}</span><StatusChip status={item.status}>{item.status}</StatusChip><div className="quick-actions"><Button disabled={busy === item.id} onClick={() => void viewInvoice(item.id)} tone="secondary">View Invoice</Button><Button disabled={busy === `pdf:${item.id}`} onClick={() => void download(item)} tone="secondary">Download PDF</Button></div></div>)}</div> : <EmptyState message="No verified Stripe Test Mode invoices have been issued." />}</Card>
    {invoice ? <Card className="dg-bill-invoice-detail"><p className="eyebrow">Invoice detail</p><h2>{invoice.invoiceNumber}</h2><div className="billing-usage-grid"><Usage label="Plan" used={title(invoice.plan)} /><Usage label="Amount" used={money(invoice.amountDue, invoice.currency)} /><Usage label="Provider" used={`${title(invoice.provider)} ${title(invoice.mode)} Mode`} /><Usage label="Payment" used={invoice.status} /></div><p>Transaction: {invoice.providerTransactionId}</p><p>Period: {dateTime(invoice.billingPeriodStart)} to {dateTime(invoice.billingPeriodEnd)}</p></Card> : null}
  </div>;
}

function Usage({ label, used, limit, over }) { const ratio = limit ? Math.min(100, Math.round((Number(used) / Number(limit)) * 100)) : null; return <div className={over ? "usage-over-limit" : ratio === 100 ? "usage-at-limit" : ""}><span>{label}</span><strong>{used}{limit != null ? <small> / {limit}</small> : null}</strong>{ratio != null && Number.isFinite(ratio) ? <i className="dg-bill-meter"><b style={{ width: `${ratio}%` }} /></i> : null}{over ? <small>OVER_LIMIT</small> : null}</div>; }
