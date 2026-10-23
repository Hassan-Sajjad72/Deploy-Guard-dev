import "reflect-metadata";
import * as assert from "node:assert/strict";
import { ConfigService } from "@nestjs/config";
import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { hostingCostTemplate, HostingPricingService, normalizeHostingPrices, PriceWorkload } from "../src/planning/hosting-pricing.service";
import { compareHosting } from "../src/planning/deployment-plan";
import { CustomerAwsSessionService, ecsSessionPolicy } from "../src/planning/customer-aws-session.service";
import { Project } from "../src/projects/project.entity";

const input: PriceWorkload = { region: "us-east-1", serviceCount: 2, managedDatabase: false, assumptions: { cpu: .5, memoryMiB: 1024, replicas: 1, storageGiB: 20, monthlyRequests: 100000, monthlyTransferGiB: 10, monthlyLogGiB: 1, availability: "single_instance", stateful: false, continuousCompute: true, monthlyBudgetUsd: 100 } };
const template = hostingCostTemplate("ecs_fargate", input)!;
assert.equal(Object.keys((template.terraform.resource as any).aws_ecs_service).length, 2);
assert.equal((template.terraform.resource as any).aws_ecs_task_definition.application_0.cpu, "512");
assert.equal((template.usage.resource_usage as any)["aws_data_transfer.application"].monthly_outbound_internet_gb, 10);
assert.equal(hostingCostTemplate("static", input), null);
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

const ids = { organizationId: "11111111-1111-4111-8111-111111111111", bindingId: "22222222-2222-4222-8222-222222222222", projectId: "33333333-3333-4333-8333-333333333333", operationId: "44444444-4444-4444-8444-444444444444", region: "us-east-1" };
const binding: any = { id: ids.bindingId, organizationId: ids.organizationId, accountId: "123456789012", roleArn: "arn:aws:iam::123456789012:role/customer", externalId: "test-external-id", regions: ["us-east-1"], verificationStatus: "verified", verificationEvidence: { mutationAuthority: "verified" }, verifiedAt: new Date() };
let callbacks = 0, calls: any[] = [], accountId = binding.accountId;
const original = STSClient.prototype.send;
STSClient.prototype.send = (async function(command: any) {
  calls.push(command);
  if (command instanceof AssumeRoleCommand) return { Credentials: { AccessKeyId: "temporary-access-key", SecretAccessKey: "temporary-secret", SessionToken: "temporary-session", Expiration: new Date(Date.now() + 900000) } };
  assert(command instanceof GetCallerIdentityCommand);
  return { Account: accountId, Arn: `arn:aws:sts::${accountId}:assumed-role/customer/test` };
}) as any;
const data: any = { getRepository: (entity: any) => ({ findOneBy: async () => entity === Project ? { id: ids.projectId, organizationId: ids.organizationId, awsAccountBindingId: ids.bindingId } : binding,
  createQueryBuilder: () => ({ addSelect() { return this; }, where() { return this; }, getOne: async () => binding }) }) };
async function main() {
  try {
    const prices = new HostingPricingService({ runConfigurationBreakdown: async () => { throw new Error("provider-down secret=redacted"); } } as any);
    const failureCosts = await prices.estimate(input);
    assert.equal(failureCosts.length, 3);
    assert(failureCosts.every((cost) => cost.items[0].monthlyUsd === null));
    assert(!JSON.stringify(failureCosts).includes("secret="));
    const session = new CustomerAwsSessionService(data, new ConfigService({ AWS_ONBOARDING_CONTROL_PLANE_ROLE_ARN: "arn:aws:iam::999999999999:role/control" }));
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
  } finally { STSClient.prototype.send = original; }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
