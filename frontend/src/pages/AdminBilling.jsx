import { useEffect, useRef, useState } from "react";
import { Button, Callout, PageHeader } from "../components/common/DesignSystem.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import { adjustOrganizationInvoice, cancelOrganizationSubscription, changeOrganizationInvoice, getBillingWorkspaces, getOrganizationInvoices, issueOrganizationInvoice, reconcileOrganizationInvoice, verifyBillingIdentity } from "../api/organizationBillingApi.js";
import { formatDateTime } from "../utils/time.js";

export default function AdminBilling() {
  const [workspaces, setWorkspaces] = useState([]), [organizationId, setOrganizationId] = useState("");
  const [invoices, setInvoices] = useState([]), [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const request = useRef(0);
  const invoiceKey = useRef(crypto.randomUUID());
  useEffect(() => {
    if (!organizationId) return;
    const current = ++request.current;
    setInvoices([]); setLoading(true); setError("");
    getOrganizationInvoices(organizationId).then((result) => { if (current === request.current) setInvoices(result.invoices); }).catch((caught) => { if (current === request.current) setError(caught.message); }).finally(() => { if (current === request.current) setLoading(false); });
    return () => { request.current++; };
  }, [organizationId]);
  async function run(action, message) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); if (organizationId) setInvoices((await getOrganizationInvoices(organizationId)).invoices); setNotice(message); }
    catch (caught) { setError(caught.message); } finally { setBusy(false); }
  }
  function confirmIdentity(event) {
    event.preventDefault(); const form = event.currentTarget; const password = new FormData(form).get("password");
    void run(async () => { await verifyBillingIdentity(password); form.reset(); const result = await getBillingWorkspaces(); setWorkspaces(result.workspaces); setVerified(true); setOrganizationId((current) => current || result.workspaces[0]?.id || ""); }, "Billing identity confirmed for 15 minutes.");
  }
  function issue(event) {
    event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
    void run(async () => { await issueOrganizationInvoice({ organizationId, idempotencyKey: invoiceKey.current, plan: values.get("plan"), amountDueCents: Number(values.get("amountDueCents")), dueAt: new Date(values.get("dueAt")).toISOString(), periodStart: new Date(values.get("periodStart")).toISOString(), periodEnd: new Date(values.get("periodEnd")).toISOString(), reason: values.get("reason") }); invoiceKey.current = crypto.randomUUID(); form.reset(); }, "Invoice issued. Paid entitlements require external payment reconciliation.");
  }
  return <div className="page settings-page"><PageHeader title="Organization billing" description="Issue B2B invoices and reconcile externally verified USD payments. AWS infrastructure charges remain separate." />
    {error ? <Callout tone="danger"><p>{error}</p></Callout> : null}{notice ? <p role="status">{notice}</p> : null}
    <section className="panel"><h2>Confirm billing operator identity</h2><form className="form-grid" onSubmit={confirmIdentity}><label className="field"><span>Administrator password</span><input name="password" type="password" autoComplete="current-password" required disabled={busy} /></label><Button type="submit" disabled={busy}>Confirm identity</Button></form></section>
    {verified ? <><div className="field"><label htmlFor="invoice-workspace">Organization</label><select id="invoice-workspace" value={organizationId} disabled={busy} onChange={(event) => setOrganizationId(event.target.value)}>{workspaces.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.kind}</option>)}</select></div>
      {loading ? <LoadingState message="Loading invoices…" /> : null}
      {organizationId ? <><section className="panel"><h2>Issue an invoice</h2><form className="form-grid" onSubmit={issue}>
        <label className="field" htmlFor="invoice-plan"><span>Subscription plan</span><select aria-label="Subscription plan" id="invoice-plan" name="plan" disabled={busy}><option value="pro">Pro</option><option value="pro_plus">Pro Plus</option></select></label>
        <label className="field"><span>Amount in USD cents</span><input name="amountDueCents" type="number" min={1} max={2147483647} step={1} required disabled={busy} /></label>
        <label className="field"><span>Due date</span><input name="dueAt" type="datetime-local" required disabled={busy} /></label>
        <label className="field"><span>Period starts</span><input name="periodStart" type="datetime-local" required disabled={busy} /></label>
        <label className="field"><span>Period ends</span><input name="periodEnd" type="datetime-local" required disabled={busy} /></label>
        <label className="field"><span>Invoice reason</span><input name="reason" required maxLength={1000} disabled={busy} /></label><Button type="submit" disabled={busy}>Issue invoice</Button>
      </form></section>
      <section className="panel"><h2>Invoices and receipts</h2>{invoices.map((invoice) => <article key={invoice.id}><h3 className="mono" style={{ overflowWrap: "anywhere" }}>{invoice.invoiceNumber}</h3><p>{(invoice.amountDue / 100).toFixed(2)} {invoice.currency} · {invoice.plan} · {invoice.status}</p><p>Due {formatDateTime(invoice.dueAt)} · Paid {formatDateTime(invoice.paidAt)}</p>{invoice.providerTransactionId ? <p>Receipt: {invoice.providerTransactionId}</p> : null}
        {invoice.adjustmentOfInvoiceId ? <p>Adjustment of invoice {invoice.adjustmentOfInvoiceId}. The original remains in financial history.</p> : null}
        {invoice.provider === "b2b" && invoice.status === "open" ? <InvoiceAdjustment invoice={invoice} organizationId={organizationId} busy={busy} run={run} /> : null}
        {invoice.provider === "b2b" && invoice.status === "open" ? <form className="form-grid" onSubmit={(event) => {
          event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
          void run(async () => { await reconcileOrganizationInvoice(organizationId, invoice.id, { externalPaymentReference: values.get("reference"), amountPaidCents: Number(values.get("amountPaidCents")), paidAt: new Date(values.get("paidAt")).toISOString(), reason: values.get("reason") }); form.reset(); }, "External payment reconciled and subscription period recorded.");
        }}><label className="field"><span>External payment reference</span><input name="reference" required maxLength={200} disabled={busy} /></label><label className="field"><span>Paid amount in USD cents</span><input name="amountPaidCents" type="number" min={1} max={2147483647} step={1} required disabled={busy} /></label><label className="field"><span>Payment received at</span><input name="paidAt" type="datetime-local" required disabled={busy} /></label><label className="field"><span>Reconciliation reason</span><input name="reason" required maxLength={1000} disabled={busy} /></label><label><input type="checkbox" required disabled={busy} /> I verified this payment against the external receipt.</label><Button type="submit" disabled={busy}>Reconcile payment</Button></form> : null}
        {invoice.provider === "b2b" && ["open", "paid"].includes(invoice.status) ? <form className="form-grid" onSubmit={(event) => { event.preventDefault(); const reason = new FormData(event.currentTarget).get("reason"); void run(() => changeOrganizationInvoice(organizationId, invoice.id, { action: invoice.status === "open" ? "void" : "dispute", reason }), "Invoice status updated. Financial history is retained."); }}><label className="field"><span>Status change reason</span><input name="reason" required maxLength={1000} disabled={busy} /></label><Button type="submit" disabled={busy}>{invoice.status === "open" ? "Void unpaid invoice" : "Record payment dispute"}</Button></form> : null}
      </article>)}{!invoices.length && !loading ? <p>No invoices for this organization.</p> : null}</section>
      <details className="disclosure"><summary>Cancel externally reconciled subscription</summary><p>This stops paid platform entitlements. Customer AWS workloads and financial records are retained.</p><form className="form-grid" onSubmit={(event) => { event.preventDefault(); const reason = new FormData(event.currentTarget).get("reason"); void run(() => cancelOrganizationSubscription(organizationId, reason), "Subscription cancelled; customer workloads and invoices are retained."); }}><label className="field"><span>Cancellation reason</span><input name="reason" required maxLength={1000} disabled={busy} /></label><Button type="submit" disabled={busy}>Cancel B2B subscription</Button></form></details></> : null}
    </> : null}
  </div>;
}

function InvoiceAdjustment({ invoice, organizationId, busy, run }) {
  const key = useRef(crypto.randomUUID());
  return <details className="disclosure"><summary>Adjust unpaid invoice</summary><p>Creates a replacement invoice and voids this unpaid invoice. The original amount and due date remain in history.</p><form className="form-grid" onSubmit={(event) => {
    event.preventDefault(); const values = new FormData(event.currentTarget);
    void run(() => adjustOrganizationInvoice(organizationId, invoice.id, { idempotencyKey: key.current, amountDueCents: Number(values.get("amountDueCents")), reason: values.get("reason") }), "Adjustment recorded; original invoice retained.");
  }}><label className="field"><span>Adjusted amount in USD cents</span><input name="amountDueCents" type="number" min={1} max={2147483647} step={1} required disabled={busy} /></label><label className="field"><span>Adjustment reason</span><input name="reason" required maxLength={1000} disabled={busy} /></label><Button type="submit" disabled={busy}>Record adjustment</Button></form></details>;
}
