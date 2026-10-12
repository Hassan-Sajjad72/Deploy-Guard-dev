import { strict as assert } from "node:assert";
import { operationalEvidence, evidencePdfLines } from "../src/terraform-export/operational-evidence";
import { renderPdfLines } from "../src/common/pdf";
import { renderInvoicePdf } from "../src/billing/invoice-pdf";
import { OperationalEvidenceController } from "../src/terraform-export/operational-evidence.controller";
import { DeploymentPlan } from "../src/planning/deployment-plan.entity";
import { IntelligenceRecord } from "../src/operational-intelligence/intelligence-record.entity";
import { GovernedRecoveryDecision, GovernedRecoveryRequest, SupervisedRepairProposal } from "../src/recovery/recovery.entity";

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
async function verifyArchive() {
  const project: any = { id: "project", name: "App", organizationId: "workspace", environmentName: "staging" };
  const createdAt = new Date();
  const records = new Map<any, any[]>([
    [DeploymentPlan, [{ id: "plan", version: 2, fingerprint: "a".repeat(64), content: { repository: { sourceSha: "abc123" }, operationId: "operation", secretValues: "must-not-export" }, createdAt }]],
    [IntelligenceRecord, [{ id: "incident", kind: "incident", fingerprint: "b".repeat(64), content: { rawLogs: "must-not-export" }, createdAt }]],
    [GovernedRecoveryRequest, [{ id: "recovery", incidentId: "incident", fingerprint: "c".repeat(64), status: "succeeded", operationId: "operation", createdAt, completedAt: createdAt }]],
    [GovernedRecoveryDecision, [{ requestId: "recovery", actorUserId: 1, actorRole: "approver", fingerprint: "c".repeat(64), decision: "approved", createdAt }]],
    [SupervisedRepairProposal, [{ id: "repair", fingerprint: "d".repeat(64), status: "unverified", pullRequestUrl: null, content: { files: [{ content: "must-not-export" }] }, createdAt }]],
  ]);
  const audit: any[] = [];
  const controller = new OperationalEvidenceController({ getProjectForView: async (user: any) => { if (user.id !== 1) throw new Error("Project access required"); return project; } } as any,
    { getCurrentState: async () => state } as any, { record: async (row: any) => audit.push(row) } as any,
    { getRepository: (entity: any) => ({ find: async () => records.get(entity) || [] }), query: async () => [] } as any);
  let archive: Buffer = Buffer.alloc(0);
  const headers: any = {};
  const response: any = { setHeader: (name: string, value: string) => { headers[name] = value; }, send: (value: Buffer) => { archive = value; } };
  await controller.zip({ user: { id: 1 } } as any, response, "project");
  assert.equal(headers["Content-Type"], "application/zip");
  assert.equal(headers["Cache-Control"], "private, no-store");
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  assert.match(archive.toString(), /operational-evidence.json/);
  assert.match(archive.toString(), /operational-evidence.pdf/);
  assert.match(archive.toString(), /"recoveryApprovals"/);
  assert.match(archive.toString(), /"sourceSha": "abc123"/);
  assert.doesNotMatch(archive.toString(), /must-not-export|secretValues|rawLogs/);
  assert.equal(audit[0].metadata.format, "zip");
  await assert.rejects(() => controller.zip({ user: { id: 2 } } as any, response, "project"), /Project access/);
  console.log("Operational JSON/PDF/ZIP evidence checks passed: secret exclusion, retained R2/R3 identities, project authorization, unknown costs and invoice compatibility.");
}
verifyArchive().catch((error) => { console.error(error); process.exitCode = 1; });
