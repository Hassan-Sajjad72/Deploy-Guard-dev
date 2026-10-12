import { AwsPublicPricingService } from "./aws-public-pricing.service";
import { Injectable } from "@nestjs/common";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InfracostService } from "../finops/infracost.service";
import { knownMonthlyPrice } from "../finops/pricing-amount";
import { HostingCost, HostingProfile, planFingerprint, WorkloadAssumptions } from "./deployment-plan";

export type PriceWorkload = { region: string; assumptions: WorkloadAssumptions; serviceCount: number; managedDatabase: boolean; runtimeSecretCount?: number; database?: { engine: string; backup: boolean } | null };
type CostTemplate = { terraform: Record<string, unknown>; usage: Record<string, unknown>; categories: Record<string, string>; unknowns: Array<{category: string; reason: string}>; known: Array<{category: string; reason: string}> };

// These documents are price previews only; Terraform never initializes, plans or applies them.
const LIGHTSAIL_BUNDLES = [{ id: "nano_3_0", cpu: 2, memory: 512 }, { id: "micro_3_0", cpu: 2, memory: 1024 }, { id: "small_3_0", cpu: 2, memory: 2048 }, { id: "medium_3_0", cpu: 2, memory: 4096 }, { id: "large_3_0", cpu: 2, memory: 8192 }];
const lightsailBundle = (a: WorkloadAssumptions, serviceCount: number) => LIGHTSAIL_BUNDLES.find((item) => item.cpu >= a.cpu * serviceCount && item.memory >= a.memoryMiB * serviceCount);

export function hostingCostTemplate(profile: HostingProfile, input: PriceWorkload): CostTemplate | null {
  if (!["ecs_fargate", "ec2", "lightsail", "lambda", "static"].includes(profile)) return null;
  const { assumptions: a, region, serviceCount } = input;
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region) || !Number.isInteger(serviceCount) || serviceCount < 1 || serviceCount > 20) throw new Error("Invalid price workload scope.");
  const p = a.pricing;
  const resource: Record<string, Record<string, any>> = {};
  const resource_usage: Record<string, unknown> = {};
  const categories: Record<string, string> = {};
  const unknowns: CostTemplate["unknowns"] = [];
  // Charges established as structurally zero for a profile, each with its justification.
  const known: CostTemplate["known"] = [];
  const add = (type: string, name: string, value: unknown, category: string, usage?: unknown) => {
    (resource[type] ||= {})[name] = value; categories[`${type}.${name}`] = category;
    if (usage) resource_usage[`${type}.${name}`] = usage;
  };
  if (profile === "ecs_fargate") {
    for (let i = 0; i < serviceCount; i++) {
      (resource.aws_ecs_task_definition ||= {})[`application_${i}`] = { family: `preview-${i}`, requires_compatibilities: ["FARGATE"], network_mode: "awsvpc", cpu: String(a.cpu * 1024), memory: String(a.memoryMiB), container_definitions: "[]" };
      add("aws_ecs_service", `application_${i}`, { name: `preview-${i}`, launch_type: "FARGATE", desired_count: a.replicas, task_definition: `\${aws_ecs_task_definition.application_${i}.arn}` }, "compute");
      add("aws_lb", `application_${i}`, { load_balancer_type: "application", internal: false }, "network", { processed_bytes_gb: a.monthlyTransferGiB / serviceCount / 730, ...(p ? { new_connections: p.albNewConnectionsPerSecond, active_connections: p.albActiveConnectionsPerMinute, rule_evaluations: p.albRuleEvaluationsPerSecond } : {}) });
      add("aws_ecr_repository", `application_${i}`, { name: `preview-${i}` }, "storage", p ? { storage_gb: p.imageStorageGiB / serviceCount } : undefined);
    }
    if (!p) unknowns.push({ category: "network", reason: "Load balancer connection concurrency/duration and public IPv4 utilization require workload-specific evidence; a partial ALB estimate is not total network cost." },
      { category: "storage", reason: "Immutable image sizes and Fargate ephemeral storage requirements have not been measured." });
  } else if (profile === "ec2") {
    const memory = a.memoryMiB * serviceCount, cpu = a.cpu * serviceCount;
    const instance = [{ id: "t3.small", cpu: 2, memory: 2048 }, { id: "t3.medium", cpu: 2, memory: 4096 }, { id: "t3.large", cpu: 2, memory: 8192 }, { id: "m6i.xlarge", cpu: 4, memory: 16384 }, { id: "m6i.2xlarge", cpu: 8, memory: 32768 }].find((item) => item.cpu >= cpu && item.memory >= memory);
    if (!instance) return null;
    for (let i = 0; i < a.replicas; i++) {
      add("aws_instance", `application_${i}`, { instance_type: instance.id, ami: "pricing-preview-only", credit_specification: [{ cpu_credits: "standard" }], root_block_device: [{ volume_type: "gp3", volume_size: Math.max(8, a.storageGiB) }] }, "compute", { monthly_hrs: 730, operating_system: "linux" });
      add("aws_eip", `application_${i}`, { domain: "vpc" }, "network");
    }
    // The encrypted root disk is priced in the instance breakdown and the EC2 profile creates no snapshots or backups.
    if (p) add("aws_ecr_repository", "application", { name: "preview" }, "storage", { storage_gb: p.imageStorageGiB });
    else unknowns.push({ category: "storage", reason: "Root disk is included in the instance breakdown; image storage requires reviewed quantities." });
  } else if (profile === "lambda") {
    // Priced at x86_64 rates, which are never lower than arm64, so the estimate does not understate compute.
    const duration = p?.averageRequestDurationMs;
    add("aws_lambda_function", "application", { function_name: "pricing-preview", role: "pricing-preview-only", handler: "index.handler", runtime: "nodejs22.x", memory_size: Math.min(10240, Math.max(128, a.memoryMiB)), architectures: ["x86_64"] }, "compute",
      duration ? { monthly_requests: a.monthlyRequests, request_duration_ms: duration } : undefined);
    if (!duration) unknowns.push({ category: "compute", reason: "Lambda duration charges require a reviewed average request duration." });
    add("aws_apigatewayv2_api", "application", { name: "pricing-preview", protocol_type: "HTTP" }, "requests", { monthly_requests: a.monthlyRequests });
    known.push({ category: "network", reason: "No load balancer, NAT gateway or public IPv4 address is provisioned; HTTP API request charges are itemized separately." });
  } else if (profile === "static") {
    add("aws_s3_bucket", "site", { bucket: "pricing-preview-site" }, "storage", { standard: { storage_gb: a.storageGiB, monthly_tier_1_requests: 1000, monthly_tier_2_requests: a.monthlyRequests, monthly_select_data_scanned_gb: 0, monthly_select_data_returned_gb: 0 } });
    add("aws_cloudfront_distribution", "site", { enabled: true, price_class: "PriceClass_100", origin: [{ domain_name: "pricing-preview.s3.amazonaws.com", origin_id: "site" }],
      default_cache_behavior: [{ allowed_methods: ["GET", "HEAD"], cached_methods: ["GET", "HEAD"], target_origin_id: "site", viewer_protocol_policy: "redirect-to-https" }],
      restrictions: [{ geo_restriction: [{ restriction_type: "none" }] }], viewer_certificate: [{ cloudfront_default_certificate: true }] }, "network",
      // No invalidations (each generation is a new distribution) and GET/HEAD only (no origin uploads). HTTP is answered
      // with a billed redirect to HTTPS, so every request is also counted as HTTP: an upper bound, never an understatement.
      { monthly_data_transfer_to_internet_gb: { us: a.monthlyTransferGiB }, monthly_https_requests: { us: a.monthlyRequests }, monthly_http_requests: { us: a.monthlyRequests }, monthly_data_transfer_to_origin_gb: { us: 0 }, monthly_invalidation_requests: 0 });
    known.push({ category: "compute", reason: "Static hosting provisions no application compute." },
      { category: "requests", reason: "CDN request charges are itemized in the CloudFront network estimate (North America/Europe PriceClass_100 rates; viewers elsewhere cost more)." },
      { category: "data_transfer", reason: "S3-to-CloudFront origin transfer has no charge; viewer transfer is itemized in the CloudFront network estimate." });
  } else {
    const bundle = lightsailBundle(a, serviceCount);
    if (!bundle) return null;
    add("aws_lightsail_instance", "application", { name: "pricing-preview", availability_zone: `${region}a`, blueprint_id: "amazon_linux_2023", bundle_id: bundle.id }, "compute");
    // Bundle disk, included transfer and the attached static IP are priced from the AWS Lightsail offer file in estimate().
  }
  add("aws_cloudwatch_log_group", "application", { name: "pricing-preview", retention_in_days: 30 }, "monitoring", { storage_gb: a.monthlyLogGiB, monthly_data_ingested_gb: a.monthlyLogGiB, monthly_data_scanned_gb: 0 });
  if (profile !== "static" && profile !== "lightsail") resource_usage["aws_data_transfer.application"] = { region, monthly_outbound_internet_gb: a.monthlyTransferGiB, ...(p ? { monthly_intra_region_gb: p.monthlyIntraRegionGiB, monthly_outbound_us_east_to_us_east_gb: 0, monthly_outbound_other_regions_gb: 0 } : {}) };
  if (profile !== "static" && profile !== "lightsail") categories["aws_data_transfer.application"] = "data_transfer";
  if (p) {
    add("aws_s3_bucket", "terraform_state", { bucket: "pricing-preview-state" }, "storage", { standard: { storage_gb: p.stateStorageGiB, monthly_tier_1_requests: p.monthlyStateWriteRequests, monthly_tier_2_requests: p.monthlyStateReadRequests, monthly_select_data_scanned_gb: 0, monthly_select_data_returned_gb: 0 } });
    const secretCount = (input.runtimeSecretCount || 0) + (input.managedDatabase ? 2 : 0);
    for (let i = 0; i < secretCount; i++) add("aws_secretsmanager_secret", `runtime_${i}`, { name: `pricing-preview-secret-${i}` }, "requests", { monthly_requests: Math.floor(p.monthlySecretApiRequests / secretCount) + (i < p.monthlySecretApiRequests % secretCount ? 1 : 0) });
    if (profile === "ecs_fargate" && input.managedDatabase && input.database) {
      (resource.aws_ecs_task_definition ||= {}).database = { family: "preview-database", requires_compatibilities: ["FARGATE"], network_mode: "awsvpc", cpu: "512", memory: "1024", container_definitions: "[]" };
      add("aws_ecs_service", "database", { name: "preview-database", launch_type: "FARGATE", desired_count: 1, task_definition: "${aws_ecs_task_definition.database.arn}" }, "database");
      add("aws_efs_file_system", "database", { creation_token: "pricing-preview", throughput_mode: "bursting" }, "database", { storage_gb: a.storageGiB });
      if (input.database.backup) add("aws_backup_vault", "database", { name: "pricing-preview-backup" }, "database", { monthly_efs_warm_backup_gb: p.backupStorageGiB });
    } else if (input.managedDatabase) unknowns.push({ category: "database", reason: "This provider's configured database execution topology has no matching engine-specific pricing contract." });
  } else {
    unknowns.push({ category: "storage", reason: "Review state storage, image storage and backup quantities before pricing." }, { category: "requests", reason: "Review state and secret API request quantities before pricing." });
    if (input.managedDatabase) unknowns.push({ category: "database", reason: "Database compute, persistence, backup and secret-access utilization require a sealed engine-specific price contract." });
  }
  return { terraform: { provider: { aws: { region } }, resource }, usage: { version: 0.1, resource_usage }, categories, unknowns, known };
}

export function normalizeHostingPrices(profile: HostingProfile, input: PriceWorkload, template: CostTemplate, raw: any): HostingCost {
  const items: HostingCost["items"] = [];
  const costComponents = (resource: any): any[] => [...(resource.costComponents || []), ...(resource.subresources || []).flatMap(costComponents)];
  const resources = (Array.isArray(raw.projects) ? raw.projects : []).flatMap((project: any) => Array.isArray(project?.breakdown?.resources) ? project.breakdown.resources : []);
  for (const resource of resources) {
    const category = template.categories[resource.name];
    if (!category) continue;
    const components = costComponents(resource);
    const complete = components.length > 0 && components.every((component: any) => knownMonthlyPrice(component.monthlyCost) !== null);
    items.push({ category, monthlyUsd: complete ? knownMonthlyPrice(resource.monthlyCost) : null, kind: ["monitoring", "data_transfer"].includes(category) ? "variable" : "fixed", reason: `Infracost resource ${String(resource.name).slice(0, 160)}; quantities come from the reviewed workload assumptions.` });
  }
  for (const [address, category] of Object.entries(template.categories)) if (!resources.some((resource: any) => resource.name === address)) items.push({ category, monthlyUsd: null, kind: "variable", reason: `Provider price missing for ${address}.` });
  for (const unknown of template.unknowns) items.push({ ...unknown, monthlyUsd: null, kind: "variable" });
  for (const zero of template.known) items.push({ ...zero, monthlyUsd: 0, kind: "fixed" });
  if (["ecs_fargate", "ec2", "lightsail"].includes(profile)) items.push({ category: "requests", monthlyUsd: 0, kind: "variable", reason: "This compute preview has no per-request compute tariff; load balancer request utilization is included in network pricing and remains blocked until resolved." });
  return { profile, region: input.region, source: "Infracost cloud pricing (infrastructure preview; no AWS resources created)", estimatedAt: new Date().toISOString(), assumptionsFingerprint: planFingerprint(input.assumptions), items };
}

@Injectable()
export class HostingPricingService {
  constructor(private readonly infracost: InfracostService, private readonly publicPricing?: AwsPublicPricingService) {}
  async estimate(input: PriceWorkload): Promise<HostingCost[]> {
    const costs: HostingCost[] = [];
    // Bound provider calls and temporary documents; secrets/source files never enter pricing.
    for (const profile of ["ecs_fargate", "ec2", "lightsail", "lambda", "static"] as const) {
      const template = hostingCostTemplate(profile, input);
      if (!template) continue;
      const workdir = await mkdtemp(join(tmpdir(), "deployguard-hosting-price-"));
      try {
        const cost = normalizeHostingPrices(profile, input, template, await this.infracost.runConfigurationBreakdown(template.terraform, template.usage, workdir));
        if (profile === "ecs_fargate") {
          const quantity = input.assumptions.pricing?.publicIpv4Count;
          const ipv4 = quantity !== undefined ? await this.publicPricing?.ipv4(input.region) : null;
          cost.items.push({ category: "network", monthlyUsd: ipv4 && quantity !== undefined ? ipv4.value * quantity * 730 : null, kind: "variable", reason: ipv4 ? `AWS public IPv4 in-use rate from ${ipv4.source}; ${quantity} reviewed addresses over 730 hours.` : "Current regional AWS public IPv4 price and reviewed address quantity are required." });
        }
        if (profile === "lightsail") {
          const bundle = lightsailBundle(input.assumptions, input.serviceCount)!;
          const terms = await this.publicPricing?.lightsail(input.region, bundle.memory / 1024);
          const overageGiB = terms ? Math.max(0, input.assumptions.monthlyTransferGiB - terms.transferQuotaGiB) : 0;
          cost.items.push(
            { category: "network", monthlyUsd: terms ? 0 : null, kind: "fixed", reason: terms ? `The attached Lightsail static IP has no charge; only unused static IP hours are billed (${terms.source}).` : "The AWS Lightsail offer file could not be read; static IP terms are unverified." },
            { category: "storage", monthlyUsd: terms && input.assumptions.storageGiB <= terms.storageGiB ? 0 : null, kind: "fixed", reason: terms ? (input.assumptions.storageGiB <= terms.storageGiB ? `${terms.storageGiB} GB SSD is included in the ${bundle.id} bundle price (${terms.source}).` : `The workload needs ${input.assumptions.storageGiB} GiB, more than the ${terms.storageGiB} GB ${bundle.id} disk.`) : "The AWS Lightsail offer file could not be read; bundle disk is unverified." },
            { category: "data_transfer", monthlyUsd: terms ? overageGiB * terms.overageUsdPerGiB : null, kind: "variable", reason: terms ? `${terms.transferQuotaGiB} GB/month is included in ${bundle.id}; ${overageGiB} GiB above it at $${terms.overageUsdPerGiB}/GB (${terms.source}).` : "The AWS Lightsail offer file could not be read; transfer allowance is unverified." });
        }
        costs.push(cost);
      }
      catch { costs.push({ profile, region: input.region, source: "Infracost unavailable", estimatedAt: new Date().toISOString(), assumptionsFingerprint: planFingerprint(input.assumptions), items: [{ category: "compute", monthlyUsd: null, kind: "fixed", reason: "Current provider pricing could not be retrieved. Pricing must be completed before approval." }] }); }
      finally { await rm(workdir, { recursive: true, force: true }); }
    }
    return costs;
  }
}
