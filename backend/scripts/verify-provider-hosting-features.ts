// Focused checks for provider-hosting features: dependency detection, static/Lambda eligibility and pricing,
// recommendation explanation, observation, optimization, evidence export, session policies and billing hooks.
import { strict as assert } from "node:assert";
import { HttpException, NotFoundException } from "@nestjs/common";
import { classifyDependencies } from "../src/planning/application-dependencies";
import { compareHosting, planFingerprint } from "../src/planning/deployment-plan";
import { hostingCostTemplate, normalizeHostingPrices } from "../src/planning/hosting-pricing.service";
import { hostingProviderReadPolicy, hostingProviderSessionPolicy } from "../src/planning/hosting-provider-session.service";
import { HostingProviderAdapterService } from "../src/planning/hosting-provider-adapter.service";
import { providerOptimization } from "../src/operational-intelligence/intelligence-evidence";
import { evidencePdfLines, operationalEvidence } from "../src/terraform-export/operational-evidence";
import { UserRole } from "../src/users/user.entity";

const organizationId = "11111111-1111-4111-8111-111111111111", projectId = "22222222-2222-4222-8222-222222222222", generationId = "33333333-3333-4333-8333-333333333333";
const assumptions: any = { cpu: .5, memoryMiB: 1024, storageGiB: 1, replicas: 1, monthlyRequests: 100000, monthlyTransferGiB: 10, monthlyLogGiB: 1, availability: "single_instance", stateful: false, continuousCompute: false, monthlyBudgetUsd: 30 };

function dependencies() {
  const found = classifyDependencies([
    { serviceId: "api", key: "REDIS_URL", resolvedStatus: "provided" }, { serviceId: "api", key: "DATABASE_URL", resolvedStatus: "provided" },
    { serviceId: "web", key: "STRIPE_SECRET_KEY", resolvedStatus: "missing" }, { serviceId: "api", key: "UPLOADS_BUCKET", resolvedStatus: "provided" },
    { serviceId: "api", key: "PORT", resolvedStatus: "provided" },
  ] as any, "postgres");
  const byName = Object.fromEntries(found.map((item) => [item.name, item]));
  assert.equal(byName.Redis.kind, "cache"); assert.equal(byName.Redis.provisioning, "customer_supplied");
  assert.equal(byName.PostgreSQL.provisioning, "deployguard_attachment", "the attached engine names a generic database URL");
  assert.equal(byName.Stripe.provisioning, "missing"); assert.equal(byName["Amazon S3"].kind, "object_storage");
  assert(!found.some((item) => item.keys.includes("PORT")), "ordinary configuration is not a dependency");
}

function eligibilityAndRecommendation() {
  const fingerprint = planFingerprint(assumptions), now = new Date().toISOString();
  const priced = (profile: any, usd: number) => ({ profile, region: "us-east-1", source: "test", estimatedAt: now, assumptionsFingerprint: fingerprint,
    items: ["compute", "network", "storage", "data_transfer", "monitoring", "requests"].map((category) => ({ category, monthlyUsd: usd / 6, kind: "fixed" as const, reason: "test" })) });
  const profiles = ["ecs_fargate", "ec2", "lambda", "static"].map((id) => ({ id: id as any, available: true, implementation: "test", reason: "" }));
  const input = { region: "us-east-1", assumptions, targets: [{ status: "resolved" } as any], managedDatabase: false, requirements: { status: "READY" } as any, configuration: { references: 0, secrets: 0 }, verifiedBuildKinds: ["static", "lambda_http"] };
  const result: any = compareHosting(input, [priced("ecs_fargate", 24), priced("lambda", 6), priced("static", 3)], profiles);
  const option = (id: string) => result.options.find((item: any) => item.id === id);
  assert.equal(option("static").eligible, true); assert.equal(option("lambda").eligible, true);
  assert.equal(result.recommendedProfile, "static");
  assert.match(result.recommendation.summary, /static has the lowest estimated total monthly cost \(3\.00 USD\)/);
  assert.equal(result.recommendation.alternatives.find((item: any) => item.profile === "ecs_fargate").additionalMonthlyUsd, 21, "costlier options state the extra spend");
  assert.equal(option("ec2").eligible, false, "unpriced EC2 is never eligible");

  const withConfig: any = compareHosting({ ...input, configuration: { references: 2, secrets: 1 } }, [priced("lambda", 6), priced("static", 3)], profiles);
  assert(withConfig.options.find((item: any) => item.id === "static").reasons.some((reason: string) => /runtime configuration/.test(reason)));
  assert(withConfig.options.find((item: any) => item.id === "lambda").reasons.some((reason: string) => /secret/.test(reason)));
  const unknown: any = compareHosting({ ...input, configuration: undefined }, [priced("lambda", 6)], profiles);
  assert(unknown.options.find((item: any) => item.id === "lambda").reasons.some((reason: string) => /resolved runtime configuration/.test(reason)), "unknown configuration blocks serverless profiles");
  const continuous: any = compareHosting({ ...input, assumptions: { ...assumptions, continuousCompute: true } }, [], profiles);
  assert(continuous.options.find((item: any) => item.id === "lambda").reasons.some((reason: string) => /continuously running/.test(reason)));
  const warned: any = compareHosting({ ...input, dependencies: classifyDependencies([{ serviceId: "api", key: "REDIS_URL", resolvedStatus: "provided" }] as any, null) }, [priced("lambda", 6)], profiles);
  assert(warned.options.find((item: any) => item.id === "lambda").warnings.some((warning: string) => /no VPC attachment/.test(warning)));
  const none: any = compareHosting({ ...input, assumptions: { ...assumptions, monthlyBudgetUsd: 1 } }, [priced("static", 3)], profiles);
  assert.equal(none.recommendedProfile, null); assert.match(none.recommendation.summary, /No hosting profile/);
}

function pricing() {
  const workload = { region: "us-east-1", assumptions, serviceCount: 1, managedDatabase: false };
  for (const profile of ["lambda", "static"] as const) {
    const template = hostingCostTemplate(profile, workload)!;
    const cost = normalizeHostingPrices(profile, workload, template, { projects: [] });
    assert(cost.items.some((item) => item.monthlyUsd === null), `${profile} without provider prices stays incomplete`);
    assert(cost.items.filter((item) => item.monthlyUsd === 0).every((item) => item.reason.length > 20), "every zero charge is justified");
  }
  const lambda = hostingCostTemplate("lambda", workload)!;
  assert(lambda.unknowns.some((item) => /duration/.test(item.reason)), "Lambda duration is unknown until reviewed");
  const timed = hostingCostTemplate("lambda", { ...workload, assumptions: { ...assumptions, pricing: { averageRequestDurationMs: 120 } as any } })!;
  assert.equal((timed.usage as any).resource_usage["aws_lambda_function.application"].request_duration_ms, 120);
  assert.equal(hostingCostTemplate("static", workload)!.categories["aws_data_transfer.application"], undefined, "static transfer is CDN-priced, not double counted");
}

function policies() {
  const read: any = hostingProviderReadPolicy({ accountId: "123456789012", region: "eu-west-1", profile: "static" });
  assert.deepEqual(read.Statement[0].Condition.StringEquals["aws:RequestedRegion"], ["eu-west-1", "us-east-1"], "CloudFront metrics are read from us-east-1");
  assert(read.Statement.every((statement: any) => statement.Action.every((action: string) => /:(Get|List|Describe)/.test(action))), "observation sessions are read-only");
  const scope: any = { organizationId, projectId, bindingId: organizationId, bindingVersion: 1, accountId: "123456789012", operationId: generationId, generationId, region: "us-east-1", environment: "production", profile: "ec2", stateBucket: "state-bucket", dnsZoneId: "Z123456", dnsRecordName: `g-${generationId.replaceAll("-", "").slice(0, 12)}.example.com` };
  const ecr = hostingProviderSessionPolicy(scope).Statement.find((statement: any) => statement.Action.includes("ecr:PutImage"));
  assert.equal(ecr.Resource, `arn:aws:ecr:us-east-1:123456789012:repository/dg-${projectId.replaceAll("-", "").slice(0, 12)}-*`, "EC2 image publishing is fenced to project repositories");
}

function optimization() {
  const end = new Date(), start = new Date(end.getTime() - 24 * 3600_000);
  const rows = (metric: string, value: number, n = 48) => Array.from({ length: n }, (_, i) => ({ metric, value, timestamp: new Date(start.getTime() + i * 1800_000).toISOString() }));
  assert.equal(providerOptimization("ec2", rows("cpu_utilization", 10), { ...assumptions, cpu: 1 }, start, end, generationId).recommendations[0].cpu, 0.5);
  assert.equal(providerOptimization("ec2", rows("cpu_utilization", 10, 5), assumptions, start, end, generationId).status, "insufficient_evidence");
  const lambda: any = providerOptimization("lambda", [...rows("invocations", 1000), ...rows("throttles", 1, 1)], assumptions, start, end, generationId);
  assert(lambda.recommendations.some((item: any) => item.monthlyRequests > 1_000_000) && lambda.recommendations.some((item: any) => /throttled/.test(item.reason)));
  assert.equal(providerOptimization("static", [], assumptions, start, end, generationId).status, "insufficient_evidence");
}

function evidence() {
  const report = operationalEvidence({ id: projectId, name: "Example", organizationId }, {} as any, { configurationRequirements: [], releases: [], approvals: [], scans: [], rollbackHistory: [], plans: [], intelligence: [], recovery: [], recoveryApprovals: [], repairs: [],
    providerGenerations: [{ id: generationId, profile: "lambda", status: "verified", planId: organizationId, planFingerprint: "a".repeat(64), artifactFingerprint: "b".repeat(64), live: true, ownedResourceAddresses: ["aws_lambda_function.runtime"], createdAt: new Date(), retainedUntil: null }] } as any);
  assert.equal(report.topology.hostingProfile, "lambda", "the live provider profile is reported");
  assert.equal(report.providerGenerations.length, 1);
  assert(evidencePdfLines(report).some((line) => line.includes(`${generationId}: lambda, verified, live route`)));
}

async function adapter() {
  const project = { id: projectId, organizationId, ownerUserId: 1, environmentName: "production", status: "active", deletionIntentId: null };
  const actor = { id: 1, role: UserRole.DEVELOPER, organizationMemberships: [{ organizationId, role: "owner", archivedAt: null }] };
  const manifest = { profile: "lambda", scope: { organizationId, projectId, sourceSha: "c".repeat(40), operationId: generationId, accountId: "123456789012", region: "us-east-1" }, compatibility: { healthPath: "/health" } };
  const queries: string[] = []; let recorded: any[] | null = null; let sessions = 0;
  const data: any = {
    getRepository: () => ({ findOneBy: async () => project }),
    query: async (sql: string) => { queries.push(sql);
      if (sql.includes("plan.content AS plan")) return [{ id: generationId, createdAt: new Date(), identity: { endpoint: "https://localhost/", generationId }, manifest, plan: { services: [{ id: "api" }] } }];
      if (sql.includes("hosting_profile_routes route")) return [{ id: generationId, profile: "lambda", artifacts: { manifest }, identity: { endpoint: "https://localhost/", generationId }, promotedAt: new Date(), assumptions }];
      return []; },
    transaction: async (callback: any) => callback({ query: async (sql: string) => sql.includes("JOIN projects") ? [{ id: projectId, ownerUserId: 1, organizationId }] : [] }),
  };
  data.manager = data;
  const service = new HostingProviderAdapterService(data, { findById: async () => actor } as any, { get: (_: string, fallback: string) => fallback } as any, {} as any,
    { withSession: async () => { sessions++; throw new HttpException("Current customer mutation and final provider authorization are required.", 409); } } as any,
    {} as any, {} as any, {} as any, { recordSuccessfulLiveDeployment: async (...args: any[]) => { recorded = args; } } as any);

  const observed: any = await service.observe(actor as any, projectId);
  assert.equal(observed.status, "live"); assert.equal(observed.endpoint.transport, "unreachable", "non-public endpoints are never probed");
  assert.equal(observed.endpoint.application, "unknown", "unreachable is not reported as healthy or failed");
  assert.equal(observed.metricsStatus, "unavailable"); assert.match(observed.metricsReason, /authorization/); assert.equal(observed.sourceSha, "c".repeat(40));
  assert.equal(sessions, 1, "metrics use one read-only session");

  const target: any = await service.liveTarget(actor as any, projectId, "api");
  assert.equal(target.origin, "https://localhost"); assert.equal(target.releaseId, generationId);
  await assert.rejects(service.liveTarget(actor as any, projectId, "other"), NotFoundException);

  await (service as any).finishJob("job", true, generationId, "deploy");
  assert.deepEqual(recorded!.slice(0, 2), [1, projectId], "successful provider deployments record billing usage for the owner");
  recorded = null; await (service as any).finishJob("job", false, generationId, "deploy");
  assert.equal(recorded, null, "failed deployments do not consume usage");

  // Pipeline-built or foreign images are never republished.
  sessions = 0;
  await (service as any).publishImages(actor, { content: { selectedProfile: "ec2", profileInputs: { services: [{ id: "web", image: `999999999999.dkr.ecr.us-east-1.amazonaws.com/dg-x@sha256:${"d".repeat(64)}` }] } } }, { manifest: { scope: { ...manifest.scope, projectId } } }, "job");
  assert.equal(sessions, 0, "images from another account never open a publishing session");
}

// The AWS CLI prints nothing for a fully successful Quiet delete-objects; cleanup must treat that as success (live Lambda run 2026-10-11).
async function cliOutputParsing() {
  const { parseCliJson } = await (new Function("p", "return import(p)") as (p: string) => Promise<any>)(require("node:path").resolve(__dirname, "../../infrastructure/hosting-profiles/runtime.mjs"));
  assert.deepEqual(parseCliJson(""), {}); assert.deepEqual(parseCliJson("  \n"), {});
  assert.deepEqual(parseCliJson('{"Errors":[{"Key":"k"}]}'), { Errors: [{ Key: "k" }] });
}

// Lightsail bundle disk, transfer quota and overage come from the AWS offer file; anything missing fails closed.
function lightsailOfferTerms() {
  const { lightsailBundleTerms } = require("../src/planning/aws-public-pricing.service");
  const offer = (overage = true) => ({ offerCode: "AmazonLightsail", products: {
    B1: { productFamily: "Lightsail Instance", attributes: { regionCode: "us-east-1", operatingSystem: "Linux", usagetype: "USE1-BundleUsage:1GB", memory: "1GB", storage: "40GB", dataTransferQuota: "2TB" } },
    B6: { productFamily: "Lightsail Instance", attributes: { regionCode: "us-east-1", operatingSystem: "Linux", usagetype: "USE1-BundleUsage:1GB_IPv6", memory: "1GB", storage: "40GB", dataTransferQuota: "2TB" } },
    ...(overage ? { O1: { productFamily: "Lightsail Networking", attributes: { fromRegionCode: "us-east-1", usagetype: "USE1-DataXfer-Out-Overage-Bytes" } } } : {}) },
    terms: { OnDemand: { O1: { T: { priceDimensions: { D: { unit: "GB", beginRange: "0", pricePerUnit: { USD: "0.0900000000" } } } } } } } });
  assert.deepEqual(lightsailBundleTerms(offer(), "us-east-1", 1), { storageGiB: 40, transferQuotaGiB: 2000, overageUsdPerGiB: 0.09 });
  assert.equal(lightsailBundleTerms(offer(false), "us-east-1", 1), null, "missing overage terms fail closed");
  assert.equal(lightsailBundleTerms(offer(), "eu-west-1", 1), null, "another region's offer never prices this region");
  assert.equal(lightsailBundleTerms(offer(), "us-east-1", 2), null, "no matching bundle fails closed");
}

async function main() {
  dependencies(); eligibilityAndRecommendation(); pricing(); policies(); optimization(); evidence(); await adapter(); await cliOutputParsing(); lightsailOfferTerms();
  console.log("Provider hosting feature checks passed: dependencies, eligibility, recommendation, pricing, policies, optimization, evidence, observation, live target, billing and publish fencing.");
}
void main().catch((error) => { console.error(error); process.exit(1); });
