import { useCallback, useEffect, useState } from "react";
import { createBillingCheckout, createBillingPortal, downloadBillingInvoice, getBillingInvoice, getBillingSummary } from "../api/platformApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { Badge, Button, Callout, DataTable, DetailsDrawer, PageHeader, Status, statusTone } from "../components/common/DesignSystem.jsx";
import { useAuth } from "../hooks/useAuth.js";
import { formatDateTime } from "../utils/time.js";

const title = (plan) => String(plan || "free").replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
const planCatalog = [
  { id: "free", name: "Free", price: 0, detail: "Try DeployGuard with a small number of projects." },
  { id: "pro", name: "Pro", price: 399, detail: "For teams keeping several apps live." },
  { id: "pro_plus", name: "Pro Plus", price: 799, detail: "The highest project and live-app limits." },
];
const money = (amount, currency = "USD") => new Intl.NumberFormat(undefined, { style: "currency", currency: String(currency || "USD").toUpperCase() }).format(Number(amount || 0) / 100);

function Usage({ label, used, limit, over }) {
  const ratio = limit ? Math.min(100, Math.round((Number(used) / Number(limit)) * 100)) : null;
  const tone = over ? "tone-bad" : ratio === 100 ? "tone-warn" : "";
  return <div className={`usage${over ? " usage-over-limit" : ratio === 100 ? " usage-at-limit" : ""}`}>
    <div className="usage-row"><span>{label}</span><strong className="num">{used}{limit != null ? <span className="muted"> of {limit}</span> : null}</strong></div>
    {ratio != null && Number.isFinite(ratio) ? <div aria-hidden="true" className={`meter ${tone}`}><i style={{ width: `${ratio}%` }} /></div> : <span className="field-hint">No limit</span>}
    {over ? <span className="field-error" title="OVER_LIMIT">Over your plan's limit</span> : null}
  </div>;
}

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
    catch (caught) { setError(caught.message || "Stripe checkout could not be opened."); setBusy(""); }
  }
  async function manageBilling() {
    setBusy("portal"); setError("");
    try { const portal = await createBillingPortal(); window.location.assign(portal.portalUrl); }
    catch (caught) { setError(caught.message || "The Stripe billing portal could not be opened."); setBusy(""); }
  }
  async function viewInvoice(id) { setBusy(id); try { setInvoice(await getBillingInvoice(id)); } catch (caught) { setError(caught.message || "Invoice is unavailable."); } finally { setBusy(""); } }
  async function download(item) { setBusy(`pdf:${item.id}`); try { await downloadBillingInvoice(item); } catch (caught) { setError(caught.message || "Invoice download failed."); } finally { setBusy(""); } }

  if (!summary) return error ? <div className="page"><ErrorState message={error} onRetry={load} title="Plan details could not be loaded" /></div> : <LoadingState message="Loading your plan…" />;
  const usage = summary.workspaceUsage || {};
  const limits = usage.limits || {};
  const canUpgrade = ["admin", "developer"].includes(user?.role);
  const returned = new URLSearchParams(window.location.search).get("checkout") === "returned";
  const overLimit = usage.overLimit?.currentProjects || usage.overLimit?.liveProjects;
  const stripeConfigured = Boolean(summary.provider?.configured);
  const checkoutAllowed = canUpgrade && summary.billing?.enabled && !summary.providerSubscriptionId && stripeConfigured;
  const planOffer = (id) => id === "pro" ? summary.plan === "free" : id === "pro_plus" ? summary.plan !== "pro_plus" : false;
  const planLine = summary.plan === "free" && summary.trial?.startedAt
    ? `Trial ${summary.trial?.expired ? "ended" : "active"}${summary.trial?.endsAt ? ` · ${summary.trial?.expired ? "ended" : "ends"} ${formatDateTime(summary.trial.endsAt)}` : ""}`
    : summary.plan !== "free" && summary.billingPeriodEnd ? `Renews ${formatDateTime(summary.billingPeriodEnd)}` : `$${summary.pricing?.monthlyUsd || 0} per month`;
  return <div className="page billing-page" data-billing-mode={summary.billing?.mode || "disabled"}>
    <PageHeader description="Your plan, what you are using, and your invoices." title="Plan & usage" />
    {error ? <ErrorState message={error} onRetry={load} title="The billing action did not complete" /> : null}
    {!summary.billing?.enabled ? <Callout title="Billing is off" tone="info"><p>Projects and deployments are not limited by plan in this environment.</p></Callout> : null}
    {returned ? <Callout actions={<Button onClick={() => void load()} size="sm">Refresh</Button>} title="Checking your plan" tone="info"><p>Stripe is confirming the change. Refresh in a moment to see your new plan.</p></Callout> : null}
    {overLimit ? <Callout title="Over your plan's limit" tone="danger"><p>Existing projects keep running. {summary.enforcement?.enabled ? "New projects and deployments are blocked until usage is back within the limit or you upgrade." : "New deployments are still allowed while limits are only being observed."}</p></Callout> : null}

    <section aria-label="Current plan and usage" className="panel billing-current">
      <div className="billing-plan">
        <h2>{title(summary.planName || summary.plan)}</h2>
        <p className="secondary">{planLine}</p>
        <div className="actions">{summary.status && summary.status !== "unknown" ? <Status tone={summary.status === "active" ? "success" : statusTone(summary.status)}>{title(summary.status)}</Status> : null}{canUpgrade && summary.customerPortalAvailable ? <Button aria-busy={busy === "portal" || undefined} disabled={Boolean(busy)} external onClick={() => void manageBilling()} size="sm">{busy === "portal" ? "Opening…" : "Manage billing"}</Button> : null}</div>
      </div>
      <div className="billing-usage"><Usage label="Projects" limit={limits.currentProjects} over={usage.overLimit?.currentProjects} used={usage.currentProjects ?? 0} /><Usage label="Live apps" limit={limits.liveProjects} over={usage.overLimit?.liveProjects} used={usage.liveProjects ?? 0} /></div>
    </section>

    <section aria-labelledby="billing-plans" className="section">
      <div className="section-head"><h2 id="billing-plans">Plans</h2>{summary.billing?.mode === "test" ? <p>Payments run in Stripe test mode.</p> : null}</div>
      <div className="plans">{planCatalog.map((plan) => <article className={`plan${summary.plan === plan.id ? " is-current" : ""}`} key={plan.id}>
        <div className="plan-head"><h3>{plan.name}</h3>{summary.plan === plan.id ? <Badge>Current</Badge> : null}</div>
        <p className="plan-price"><strong className="num">${plan.price}</strong><span className="muted"> / month</span></p>
        <p className="plan-detail">{plan.detail}</p>
        <div className="plan-action">{summary.plan === plan.id ? null : checkoutAllowed && planOffer(plan.id) ? <Button aria-busy={busy === plan.id || undefined} disabled={Boolean(busy)} onClick={() => void upgrade(plan.id)} tone="primary">{busy === plan.id ? "Opening checkout…" : `Upgrade to ${plan.name}`}</Button> : planOffer(plan.id) ? <span className="field-hint">{summary.providerSubscriptionId ? "Change plans from Manage billing." : "Checkout is not available yet."}</span> : null}</div>
      </article>)}</div>
    </section>

    <section aria-labelledby="billing-invoices" className="section">
      <div className="section-head"><h2 id="billing-invoices">Invoices</h2></div>
      {summary.invoices?.length ? <DataTable caption="Invoices" label="Invoices"><thead><tr><th>Invoice</th><th>Plan</th><th>Paid</th><th>Amount</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{summary.invoices.map((item) => <tr key={item.id}>
        <td data-label="Invoice"><span className="mono">{item.invoiceNumber}</span></td>
        <td data-label="Plan">{title(item.plan)}</td>
        <td data-label="Paid">{formatDateTime(item.paidAt)}</td>
        <td data-label="Amount" className="num">{money(item.amountDue, item.currency)}</td>
        <td data-label="Status"><Status tone={statusTone(item.status)}>{title(item.status)}</Status></td>
        <td className="cell-end" data-label=""><div className="actions actions-end"><Button aria-busy={busy === item.id || undefined} disabled={busy === item.id} onClick={() => void viewInvoice(item.id)} size="sm" tone="ghost">View</Button><Button aria-busy={busy === `pdf:${item.id}` || undefined} disabled={busy === `pdf:${item.id}`} onClick={() => void download(item)} size="sm" tone="ghost">PDF</Button></div></td>
      </tr>)}</tbody></DataTable> : <p className="muted billing-empty">Invoices appear here after your first paid billing period.</p>}
    </section>

    {invoice ? <DetailsDrawer labelledBy="invoice-details" onClose={() => setInvoice(null)} title={invoice.invoiceNumber}>
      <dl className="facts-list"><div><dt>Plan</dt><dd>{title(invoice.plan)}</dd></div><div><dt>Amount</dt><dd>{money(invoice.amountDue, invoice.currency)}</dd></div><div><dt>Payment</dt><dd>{title(invoice.status)}</dd></div><div><dt>Period</dt><dd>{formatDateTime(invoice.billingPeriodStart)} – {formatDateTime(invoice.billingPeriodEnd)}</dd></div></dl>
      <div className="actions"><Button onClick={() => void download(invoice)}>Download PDF</Button></div>
    </DetailsDrawer> : null}
  </div>;
}
