import { useCallback, useEffect, useState } from "react";
import { createBillingCheckout, createBillingPortal, downloadBillingInvoice, getBillingInvoice, getBillingSummary } from "../api/platformApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import EmptyState from "../components/common/EmptyState.jsx";
import { Button, Card, PageHeader, StatusChip } from "../components/common/DesignSystem.jsx";
import { useAuth } from "../hooks/useAuth.js";

const title = (plan) => String(plan || "FREE").replace("_", " ");
const dateTime = (value) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Not started";
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
  return <div className="workspace-page billing-page" data-billing-mode={summary.billing?.mode || "disabled"}>
    <PageHeader description="Manage plan capacity, trial status, usage, and payment history." eyebrow="Workspace" title="Plan & Usage" />
    {error ? <ErrorState message={error} onRetry={load} /> : null}
    {!summary.billing?.enabled ? <Card><strong>Billing is disabled.</strong><p>DeployGuard preserves unrestricted project and deployment behavior.</p></Card> : null}
    {summary.billing?.enabled && !summary.enforcement?.enabled ? <Card className="state info" role="status"><strong>FYP observation mode</strong><p>Usage and limits are visible, but quota and trial expiry do not block deployments.</p></Card> : null}
    {summary.billing?.enabled && stripeConfigured ? <Card className="state info" role="status"><strong>Stripe Test Mode</strong><p>Checkout is test-only. A plan changes only after DeployGuard verifies Stripe’s signed webhook; no real charge is possible.</p></Card> : null}
    {summary.billing?.enabled && !stripeConfigured ? <Card className="state info" role="status"><strong>Stripe Test Mode is not configured</strong><p>Plan selection is unavailable until the local Stripe test configuration is complete. Missing: {missingStripeConfiguration.join(", ") || "required Stripe configuration"}. No Stripe checkout will be started.</p></Card> : null}
    {returned ? <Card className="state info" role="status"><strong>Payment verification pending</strong><p>Returning from checkout does not activate a plan. Refresh after the verified Stripe webhook arrives.</p><Button onClick={() => void load()}>Refresh status</Button></Card> : null}
    {overLimit ? <Card className="state danger" role="alert"><strong>OVER_LIMIT</strong><p>Existing projects remain untouched. New quota-consuming transitions are {summary.enforcement?.enabled ? "blocked until usage is compliant" : "allowed while observation mode is active"}.</p></Card> : null}

    <section className="billing-summary-layout">
      <Card className="billing-plan-card"><div><p className="eyebrow">Current plan</p><h2>{title(summary.planName)}</h2><p><strong>${summary.pricing?.monthlyUsd || 0}</strong> / month</p></div><div className="billing-plan-actions"><StatusChip status={summary.status}>{summary.status}</StatusChip>{canUpgrade && summary.customerPortalAvailable ? <Button disabled={Boolean(busy)} onClick={() => void manageBilling()}>{busy === "portal" ? "Opening…" : "Manage billing"}</Button> : null}</div></Card>
      {summary.plan === "free" ? <Card className="billing-trial-card"><p className="eyebrow">Trial status</p><h2>{summary.trial?.expired ? "Expired" : summary.trial?.startedAt ? "Active" : "Available"}</h2><p>Started {dateTime(summary.trial?.startedAt)}<br />Ends {dateTime(summary.trial?.endsAt)}</p><strong>{summary.trial?.remainingSeconds == null ? "48 hours after first LIVE deployment" : `${Math.ceil(summary.trial.remainingSeconds / 3600)} hours remaining`}</strong></Card> : <Card className="billing-trial-card"><p className="eyebrow">Billing period</p><h2>{dateTime(summary.billingPeriodEnd)}</h2><p>Current Stripe Test Mode subscription period.</p></Card>}
    </section>
    <Card className="billing-usage-card"><div><p className="eyebrow">Usage summary</p><h2>Workspace capacity</h2></div><div className="billing-usage-grid"><Usage label="Current projects" used={usage.currentProjects ?? 0} limit={limits.currentProjects} over={usage.overLimit?.currentProjects} /><Usage label="LIVE projects" used={usage.liveProjects ?? 0} limit={limits.liveProjects} over={usage.overLimit?.liveProjects} /></div></Card>

    {canUpgrade && summary.billing?.enabled && !summary.providerSubscriptionId && stripeConfigured ? <section className="billing-upgrade-section"><div className="billing-section-heading"><div><p className="eyebrow">Upgrade</p><h2>Choose more deployment capacity</h2></div><p>Stripe Test Mode only. Your plan changes after the signed webhook is verified.</p></div><div className="billing-pricing-grid">{summary.plan === "free" ? <article className="billing-price-card"><span>PRO</span><strong><small>$</small>399<small>/month</small></strong><p>For active teams running multiple cloud projects.</p><Button disabled={Boolean(busy)} onClick={() => void upgrade("pro")}>{busy === "pro" ? "Opening…" : "Choose PRO"}</Button></article> : null}{summary.plan !== "pro_plus" ? <article className="billing-price-card is-premium"><span>PRO PLUS</span><strong><small>$</small>799<small>/month</small></strong><p>Expanded capacity for larger deployment portfolios.</p><Button disabled={Boolean(busy)} onClick={() => void upgrade("pro_plus")}>{busy === "pro_plus" ? "Opening…" : "Choose PRO PLUS"}</Button></article> : null}</div></section> : null}

    <Card className="billing-invoice-card"><p className="eyebrow">Payment history</p><h2>Invoices</h2>{summary.invoices?.length ? <div className="session-list">{summary.invoices.map((item) => <div className="subtle-button billing-invoice-row" key={item.id}><div><strong>{item.invoiceNumber}</strong><small>{title(item.plan)} · {dateTime(item.paidAt)}</small></div><span>{money(item.amountDue, item.currency)}</span><StatusChip status={item.status}>{item.status}</StatusChip><div className="quick-actions"><Button disabled={busy === item.id} onClick={() => void viewInvoice(item.id)}>View invoice</Button><Button disabled={busy === `pdf:${item.id}`} onClick={() => void download(item)}>Download PDF</Button></div></div>)}</div> : <EmptyState message="No invoices yet." />}</Card>
    {invoice ? <Card><p className="eyebrow">Invoice detail</p><h2>{invoice.invoiceNumber}</h2><div className="billing-usage-grid"><Usage label="Plan" used={title(invoice.plan)} /><Usage label="Amount" used={money(invoice.amountDue, invoice.currency)} /><Usage label="Provider" used={`${title(invoice.provider)} ${title(invoice.mode)} Mode`} /><Usage label="Payment" used={invoice.status} /></div><p>Transaction: {invoice.providerTransactionId}</p><p>Period: {dateTime(invoice.billingPeriodStart)} to {dateTime(invoice.billingPeriodEnd)}</p></Card> : null}
  </div>;
}

function Usage({ label, used, limit, over }) { return <div className={over ? "usage-over-limit" : ""}><span>{label}</span><strong>{used}{limit != null ? <small> / {limit}</small> : null}</strong>{over ? <small>OVER_LIMIT</small> : null}</div>; }
