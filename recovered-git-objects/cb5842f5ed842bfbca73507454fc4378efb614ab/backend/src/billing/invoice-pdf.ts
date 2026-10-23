import { BillingInvoice } from "./billing-invoice.entity";
import { User } from "../users/user.entity";

import { renderPdfLines } from "../common/pdf";

export function renderInvoicePdf(invoice: BillingInvoice, user: User) {
  const lines = [
    "DeployGuard Invoice", `Invoice: ${invoice.invoiceNumber}`, `Account: ${user.name || user.email || user.id}`,
    `Plan: ${invoice.plan.toUpperCase()}`, `Amount: ${(invoice.amountDue / 100).toFixed(2)} ${invoice.currency.toUpperCase()}`,
    `Workspace: ${invoice.organizationId || "Legacy personal account"}`,
    `Payment status: ${invoice.status}`, `Provider: ${invoice.provider} (${invoice.mode})`, `Transaction: ${invoice.providerTransactionId || "Pending reconciliation"}`,
    `Issued: ${invoice.issuedAt?.toISOString() || "-"}`, `Paid: ${invoice.paidAt?.toISOString() || "-"}`,
    `Billing period: ${invoice.billingPeriodStart?.toISOString() || "-"} to ${invoice.billingPeriodEnd?.toISOString() || "-"}`,
    `Subscription status: ${invoice.subscriptionStatus}`,
    `Due: ${invoice.dueAt?.toISOString() || "-"}`,
  ];
  return renderPdfLines(lines);
}
