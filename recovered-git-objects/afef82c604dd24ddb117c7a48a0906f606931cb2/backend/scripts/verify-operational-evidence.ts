import { strict as assert } from "node:assert";
import { operationalEvidence, evidencePdfLines } from "../src/terraform-export/operational-evidence";
import { renderPdfLines } from "../src/common/pdf";
import { renderInvoicePdf } from "../src/billing/invoice-pdf";

const state: any = {
  stableRelease: { id: "release", operationId: "operation", generationId: "generation", commit: "abc123", promotedAt: "2026-10-11T00:00:00Z", rollbackAvailable: true, runtimeIdentity: { secretValues: { PASSWORD: "must-not-export" } } },
  stateAuthority: { runtime: { state: "present" }, infrastructure: { status: "active" }, applicationHealth: { status: "failed" }, monitoring: { status: "available" } },
  environment: { PASSWORD: "must-not-export" },
  infrastructureEvidence: { region: "us-east-1", source: "aws_observation", runtimeIdentity: { accountId: "123456789012", services: [{ serviceId: "web", ecsServiceArn: "arn:aws:ecs:us-east-1:123456789012:service/project/web", environment: { PASSWORD: "must-not-export" } }] } },
  estimatedCost: { status: "unavailable", source: "infracost", monthly: null, currency: "USD", estimatedAt: null, breakdown: [] },
};
const report = operationalEvidence({ id: "project", name: "App", organizationId: "workspace" }, state);
assert.doesNotMatch(JSON.stringify(report), /must-not-export|secretValues|PASSWORD/);
assert.equal(report.applicationHealth?.status, "failed");
assert.equal(report.cost?.monthly, null);
assert.equal(report.release?.generationId, "generation");
assert.equal(report.scope.accountId, "123456789012");
assert.equal(report.topology.resourceInventory[0].serviceId, "web");
assert.equal(report.provenance.realProviderCertification, "unverified");
const pdf = renderPdfLines(evidencePdfLines(report)).toString("ascii");
assert.match(pdf, /^%PDF-1\.4/);
assert.match(pdf, /Estimated monthly cost: Unknown/);
assert.match(pdf, /Application health: failed/);
assert.match(pdf, /%%EOF/);
const multiplePages = renderPdfLines(Array.from({ length: 91 }, (_, index) => `Evidence line ${index + 1}`)).toString("ascii");
assert.match(multiplePages, /\/Count 4/);
assert.match(multiplePages, /Evidence line 91/);
const invoicePdf = renderInvoicePdf({ invoiceNumber: "DG-42", plan: "pro", amountDue: 2500, currency: "usd", status: "paid", mode: "test" } as any, { id: 1, name: "Alice" } as any).toString("ascii");
assert.match(invoicePdf, /Amount: 25.00 USD/);
assert.match(invoicePdf, /Invoice: DG-42/);
console.log("Operational JSON/PDF evidence redaction, health, unknown cost and invoice compatibility checks passed.");
