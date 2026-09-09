import { BillingInvoice } from "./billing-invoice.entity";
import { User } from "../users/user.entity";

function escapePdf(value: unknown) {
  return String(value ?? "").replace(/[^\x20-\x7e]/g, " ").replace(/([\\()])/g, "\\$1");
}

export function renderInvoicePdf(invoice: BillingInvoice, user: User) {
  const lines = [
    "DeployGuard Invoice", `Invoice: ${invoice.invoiceNumber}`, `Account: ${user.name || user.email || user.id}`,
    `Plan: ${invoice.plan.toUpperCase()}`, `Amount: ${(invoice.amountDue / 100).toFixed(2)} ${invoice.currency.toUpperCase()}`,
    `Payment status: ${invoice.status}`, `Provider: Stripe (${invoice.mode})`, `Transaction: ${invoice.providerTransactionId}`,
    `Issued: ${invoice.issuedAt?.toISOString() || "-"}`, `Paid: ${invoice.paidAt?.toISOString() || "-"}`,
    `Billing period: ${invoice.billingPeriodStart?.toISOString() || "-"} to ${invoice.billingPeriodEnd?.toISOString() || "-"}`,
    `Subscription status: ${invoice.subscriptionStatus}`,
  ];
  const stream = `BT\n/F1 12 Tf\n50 780 Td\n${lines.map((line, index) => `${index ? "0 -24 Td\n" : ""}(${escapePdf(line)}) Tj`).join("\n")}\nET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let output = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, "ascii");
}
