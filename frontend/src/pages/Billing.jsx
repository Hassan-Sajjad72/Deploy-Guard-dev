import { useCallback, useEffect, useState } from "react";
import { getBillingSummary, setMockBillingPlan } from "../api/platformApi.js";
import ErrorState from "../components/common/ErrorState.jsx";
import LoadingState from "../components/common/LoadingState.jsx";
import EmptyState from "../components/common/EmptyState.jsx";
import { Button, Card, PageHeader, StatusChip } from "../components/common/DesignSystem.jsx";
import { useAuth } from "../hooks/useAuth.js";

const title = (plan) => String(plan || "FREE").replace("_", " ");
const date = (value) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value)) : "Not started";

export default function Billing() {
  const { user } = useAuth();
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setSummary(await getBillingSummary()); setError(""); } catch (caught) { setError(caught.message || "Subscription details are unavailable."); } }, []);
  useEffect(() => { void load(); }, [load]);
  async function upgrade(plan) { setBusy(true); try { setSummary(await setMockBillingPlan(plan)); setError(""); } catch (caught) { setError(caught.message || "Mock upgrade failed."); } finally { setBusy(false); } }
  if (!summary) return <div className="workspace-page">{error ? <ErrorState message={error} onRetry={load} /> : <LoadingState message="Loading subscription…" />}</div>;
  const usage = summary.workspaceUsage || {};
  const limits = summary.entitlements || {};
  const mock = summary.billing?.enabled === true && summary.billing?.mode === "mock";
  const canUpgrade = ["admin", "developer"].includes(user?.role);
  return <div className="workspace-page billing-page" data-billing-mode={mock ? "mock" : "disabled"}>
    <PageHeader description="Current plan limits, LIVE capacity, trial status, and payment history." eyebrow="Workspace" title="Plan & Usage" />
    {error ? <ErrorState message={error} onRetry={load} /> : null}
    {!summary.enforcement?.enabled ? <Card><strong>Billing limits are disabled.</strong><p>DeployGuard preserves unrestricted project and deployment behavior.</p></Card> : null}
    {mock ? <Card className="state info" role="status"><strong>Mock / FYP billing</strong><p>No real payment gateway or charge is used by these plan controls.</p></Card> : null}
    <Card className="billing-plan-card"><div><p className="eyebrow">Current plan</p><h2>{title(summary.planName)}</h2><p>${summary.pricing?.monthlyUsd || 0} / month</p></div><StatusChip status={summary.status}>{summary.status}</StatusChip><div className="quick-actions">{mock && canUpgrade && summary.plan === "free" ? <Button disabled={busy} onClick={() => void upgrade("pro")}>Mock upgrade to PRO</Button> : null}{mock && canUpgrade && summary.plan === "pro" ? <Button disabled={busy} onClick={() => void upgrade("pro_plus")}>Mock upgrade to PRO PLUS</Button> : null}</div></Card>
    <Card><div className="compact-section-heading"><div><p className="eyebrow">Capacity</p><h2>Authoritative usage</h2></div></div><div className="billing-usage-grid"><Usage label="Current projects" used={usage.currentProjects ?? 0} limit={summary.enforcement?.enabled ? limits.currentProjects : null} /><Usage label="LIVE projects" used={usage.liveProjects ?? 0} limit={summary.enforcement?.enabled ? limits.liveProjects : null} /></div></Card>
    {summary.plan === "free" ? <Card><p className="eyebrow">Free LIVE trial</p><h2>{summary.trial?.expired ? "Expired" : summary.trial?.startedAt ? "Active" : "Available"}</h2><p>One successful LIVE deployment can run for 48 hours. Started: {date(summary.trial?.startedAt)} · Ends: {date(summary.trial?.endsAt)}</p></Card> : <Card><p className="eyebrow">Renewal</p><h2>{date(summary.billingPeriodEnd)}</h2><p>Mock billing period renewal date.</p></Card>}
    <Card><p className="eyebrow">Invoice history</p><h2>Payments</h2>{summary.invoices?.length ? <div className="session-list">{summary.invoices.map((invoice) => <div className="subtle-button" key={invoice.id}><strong>{String(invoice.status).replaceAll("_", " ")}</strong><span>${(invoice.amountDue / 100).toFixed(2)} {String(invoice.currency).toUpperCase()}</span><small>{date(invoice.issuedAt)}</small></div>)}</div> : <EmptyState message="No mock invoices have been issued." />}</Card>
  </div>;
}

function Usage({ label, used, limit }) { return <div><span>{label}</span><strong>{used}<small> / {limit ?? "Not enforced"}</small></strong></div>; }
