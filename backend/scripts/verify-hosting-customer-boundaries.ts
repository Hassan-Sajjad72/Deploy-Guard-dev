import { createHmac } from "node:crypto";
import { CUSTOMER_AUTHORITY_CHECKS } from "../src/workspaces/customer-authority-proof";
import "reflect-metadata";
import * as assert from "node:assert/strict";
import { ConfigService } from "@nestjs/config";
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { hostingCostTemplate, HostingPricingService, normalizeHostingPrices, PriceWorkload } from "../src/planning/hosting-pricing.service";
import { planFingerprint, compareHosting } from "../src/planning/deployment-plan";
import { CustomerAwsSessionService, ecsSessionPolicy } from "../src/planning/customer-aws-session.service";
import { Project } from "../src/projects/project.entity";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InfracostService } from "../src/finops/infracost.service";

const input: PriceWorkload = { region: "us-east-1", serviceCount: 2, managedDatabase: false, assumptions: { cpu: .5, memoryMiB: 1024, replicas: 1, storageGiB: 20, monthlyRequests: 100000, monthlyTransferGiB: 10, monthlyLogGiB: 1, availability: "single_instance", stateful: false, continuousCompute: true, monthlyBudgetUsd: 100 } };
const template = hostingCostTemplate("ecs_fargate", input)!;
assert.equal(Object.keys((template.terraform.resource as any).aws_ecs_service).length, 2);
assert.equal((template.terraform.resource as any).aws_ecs_task_definition.application_0.cpu, "512");
assert.equal((template.usage.resource_usage as any)["aws_data_transfer.application"].monthly_outbound_internet_gb, 10);
// Static is now priced (FR-056): no application compute, with CDN and storage itemized rather than zeroed.
const staticTemplate = hostingCostTemplate("static", input)!;
assert(staticTemplate.known.some((item) => item.category === "compute") && Object.values(staticTemplate.categories).includes("network") && Object.values(staticTemplate.categories).includes("storage"));
assert.throws(() => hostingCostTemplate("ec2", { ...input, region: "../../outside" }));
const resources = Object.keys(template.categories).map((name) => ({ name, monthlyCost: "1.25", costComponents: [{ monthlyCost: "1.25" }] }));
const priced = normalizeHostingPrices("ecs_fargate", input, template, { projects: [{ breakdown: { resources } }] });
assert(priced.items.some((item) => item.monthlyUsd === null && item.category === "network"));
const missing = normalizeHostingPrices("ecs_fargate", input, template, { projects: [{ breakdown: { resources: resources.slice(1) } }] });
assert(missing.items.some((item) => item.monthlyUsd === null && item.reason.includes(resources[0].name)));
const bad = normalizeHostingPrices("ecs_fargate", input, template, { projects: [{ breakdown: { resources: [{ ...resources[0], costComponents: [{ monthlyCost: null }] }] } }] });
assert.equal(bad.items[0].monthlyUsd, null);
const comparison = compareHosting({ ...input, targets: [{ status: "resolved" } as any], requirements: { status: "READY" } as any }, [priced]);
assert.equal(comparison.options[0].cost.monthlyUsd, null);
assert.equal(comparison.recommendedProfile, null);
const invalidSize = compareHosting({ ...input, assumptions: { ...input.assumptions, cpu: .25, memoryMiB: 4096 }, targets: [{ status: "resolved" } as any], requirements: { status: "READY" } as any });
assert(invalidSize.options[0].reasons.some((reason) => reason.includes("CPU/memory")));
assert(compareHosting({ ...input, assumptions: { ...input.assumptions, cpu: .25, memoryMiB: 1536 }, targets: [{ status: "resolved" } as any], requirements: { status: "READY" } as any }).options[0].reasons.some((reason) => reason.includes("CPU/memory")));
const persistence = compareHosting({ ...input, assumptions: { ...input.assumptions, stateful: true }, targets: [{ status: "resolved" } as any], requirements: { status: "READY" } as any });
assert(persistence.options[0].reasons.some((reason) => reason.includes("Persistent application storage")));

const ids = { organizationId: "11111111-1111-4111-8111-111111111111", bindingId: "22222222-2222-4222-8222-222222222222", projectId: "33333333-3333-4333-8333-333333333333", operationId: "44444444-4444-4444-8444-444444444444", region: "us-east-1" };
const binding: any = { id: ids.bindingId, organizationId: ids.organizationId, accountId: "123456789012", roleArn: "arn:aws:iam::123456789012:role/customer", externalId: "test-external-id", regions: ["us-east-1"], verificationStatus: "verified", verificationVersion: 1, verificationEvidence: { mutationAuthority: "verified" }, executionRoleBoundaryArns: { [ids.projectId]: `arn:aws:iam::123456789012:policy/deployguard/${ids.projectId}/ecs-task-boundary-${ids.projectId}` }, verifiedAt: new Date() };
let callbacks = 0, calls: any[] = [], accountId = binding.accountId;
const original = STSClient.prototype.send;
STSClient.prototype.send = (async function(command: any) {
  calls.push(command);
  if (command instanceof AssumeRoleCommand) return { Credentials: { AccessKeyId: "temporary-access-key", SecretAccessKey: "temporary-secret", SessionToken: "temporary-session", Expiration: new Date(Date.now() + 900000) } };
  assert(command instanceof GetCallerIdentityCommand);
  return { Account: accountId, Arn: `arn:aws:sts::${accountId}:assumed-role/customer/test` };
}) as any;
const data: any = { query: async () => [{ archived_at: null }], getRepository: (entity: any) => ({ findOneBy: async () => entity === Project ? { id: ids.projectId, organizationId: ids.organizationId, awsAccountBindingId: ids.bindingId } : binding,
  createQueryBuilder: () => ({ addSelect() { return this; }, where() { return this; }, getOne: async () => binding }) }) };
async function main() {
  const directory = await mkdtemp(join(tmpdir(), "deployguard-hosting-provider-check-"));
  try {
    const executable = join(directory, "pricing-provider");
    await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'breakdown' || !args.includes('--usage-file')) process.exit(2);
for (const file of ['main.tf.json','usage.json']) {
  if ((fs.statSync(file).mode & 0o077) !== 0) process.exit(3);
  const body = fs.readFileSync(file, 'utf8');
  if (body.includes('test-pricing-token') || body.includes('temporary-secret')) process.exit(4);
}
const body = JSON.parse(fs.readFileSync('main.tf.json', 'utf8'));
if (body.provider.aws.region !== 'us-east-1') process.exit(5);
console.log(JSON.stringify({projects:[{breakdown:{resources:[]}}]}));
`);
    await chmod(executable, 0o700);
    const provider = new InfracostService(new ConfigService({ INFRACOST_CLI_PATH: executable, INFRACOST_CLI_AUTHENTICATION_TOKEN: "test-pricing-token" }));
    assert.deepEqual(await provider.runConfigurationBreakdown(template.terraform, template.usage, directory), { projects: [{ breakdown: { resources: [] } }] });
    await writeFile(executable, "#!/usr/bin/env node\nconsole.error('Unauthorized test-pricing-token'); process.exit(1);\n");
    await assert.rejects(() => provider.runConfigurationBreakdown(template.terraform, template.usage, directory), (error: any) => error.message.includes("INFRACOST_AUTHENTICATION_REJECTED") && !error.message.includes("test-pricing-token"));
    const prices = new HostingPricingService({ runConfigurationBreakdown: async () => { throw new Error("provider-down secret=redacted"); } } as any);
    const failureCosts = await prices.estimate(input);
    assert.deepEqual(failureCosts.map((cost) => cost.profile).sort(), ["ec2", "ecs_fargate", "lambda", "lightsail", "static"]);
    assert(failureCosts.every((cost) => cost.items[0].monthlyUsd === null));
    assert(!JSON.stringify(failureCosts).includes("secret="));
    const proof = { contractVersion: "deployguard.customer-authority-proof/v1", organizationId: ids.organizationId, bindingId: ids.bindingId, bindingVersion: binding.verificationVersion, accountId: binding.accountId, roleArn: binding.roleArn, regions: binding.regions, projectIds: [ids.projectId], workflowBrokerRoles: { [ids.projectId]: `arn:aws:iam::999999999999:role/dg-customer-broker-${ids.projectId.replaceAll("-", "").slice(0, 12)}` }, executionRoleBoundaryArns: { [ids.projectId]: `arn:aws:iam::${binding.accountId}:policy/deployguard/${ids.projectId}/ecs-task-boundary-${ids.projectId}` }, verifiedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), checks: CUSTOMER_AUTHORITY_CHECKS.map((check) => ({ check, status: "verified", artifactSha256: "a".repeat(64) })), finalApproval: { approvalId: "local-unit-fixture", actorId: "1", approvedAt: new Date().toISOString() } };
    const signingKey = "unit-fixture-key-never-runtime-evidence";
    binding.verificationEvidence.authorityProof = { proof, signature: createHmac("sha256", signingKey).update(planFingerprint(proof)).digest("hex") };
    const completeInput = { ...input, runtimeSecretCount: 1, assumptions: { ...input.assumptions, pricing: { imageStorageGiB: 2, publicIpv4Count: 6, albNewConnectionsPerSecond: 1, albActiveConnectionsPerMinute: 2, albRuleEvaluationsPerSecond: 3, monthlyIntraRegionGiB: 1, stateStorageGiB: .1, monthlyStateWriteRequests: 100, monthlyStateReadRequests: 100, monthlySecretApiRequests: 100, backupStorageGiB: 0 } } };
    const completePricing = new HostingPricingService({ runConfigurationBreakdown: async (terraform: any) => { const resources = Object.entries<any>(terraform.resource).flatMap(([type, values]) => Object.keys(values).filter(() => type !== "aws_ecs_task_definition").map((name) => ({ name: `${type}.${name}`, monthlyCost: "1", costComponents: [{ monthlyCost: "1" }] }))); resources.push({ name: "aws_data_transfer.application", monthlyCost: "1", costComponents: [{ monthlyCost: "1" }] }); return { projects: [{ breakdown: { resources } }] }; } } as any, { ipv4: async () => ({ value: .005, source: "fixture-price-document" }) } as any);
    const completeCosts = await completePricing.estimate(completeInput);
    assert(completeCosts.find((cost) => cost.profile === "ecs_fargate")!.items.every((item) => item.monthlyUsd !== null), "All explicit ECS quantities plus known provider prices can produce a complete estimate.");
    const session = new CustomerAwsSessionService(data, new ConfigService({ AWS_ONBOARDING_CONTROL_PLANE_ROLE_ARN: "arn:aws:iam::999999999999:role/control", DEPLOYGUARD_FINAL_PROVIDER_PROOF_SIGNING_KEY: signingKey, DEPLOYGUARD_FINAL_PROVIDER_APPROVAL_ID: "local-unit-fixture" }));
    await session.withEcsSession({ ...ids, purpose: "restart" }, async (context) => { callbacks++; assert.equal(context.accountId, binding.accountId); assert.equal(context.credentials.sessionToken, "temporary-session"); });
    assert.equal(callbacks, 1);
    assert.equal(calls[0].input.DurationSeconds, 900);
    assert.equal(calls[0].input.ExternalId, binding.externalId);
    const policy = JSON.parse(calls[0].input.Policy);
    assert(policy.Statement.some((item: any) => item.Condition?.StringEquals?.["aws:ResourceTag/DeployGuardProjectId"] === ids.projectId));
    assert(!JSON.stringify(policy).includes('"Action":"*"'));
    assert(!JSON.stringify(ecsSessionPolicy({ ...ids, accountId: binding.accountId, purpose: "read" })).includes("ecs:UpdateService"));
    binding.verificationEvidence.mutationAuthority = "unverified";
    await assert.rejects(() => session.withEcsSession({ ...ids, purpose: "replicas" }, async () => { callbacks++; }));
    assert.equal(callbacks, 1);
    binding.verificationEvidence.mutationAuthority = "verified";
    accountId = "888888888888";
    await assert.rejects(() => session.withEcsSession({ ...ids, purpose: "restart" }, async () => { callbacks++; }));
    assert.equal(callbacks, 1);
    binding.verificationStatus = "revoked";
    await assert.rejects(() => session.withEcsSession({ ...ids, purpose: "read" }, async () => { callbacks++; }));
    binding.verificationStatus = "verified";
    await assert.rejects(() => session.withEcsSession({ ...ids, region: "eu-west-1", purpose: "read" }, async () => { callbacks++; }));
    console.log("Hosting prices preserve unknown totals; customer sessions reject unavailable mutation authority, account drift and revoked/foreign-region bindings.");
  } finally { STSClient.prototype.send = original; await rm(directory, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
