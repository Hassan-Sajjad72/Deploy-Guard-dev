import { AwsPublicPricingService } from "./aws-public-pricing.service";
import { Injectable } from "@nestjs/common";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InfracostService } from "../finops/infracost.service";
import { knownMonthlyPrice } from "../finops/pricing-amount";
import { HostingCost, HostingProfile, planFingerprint, WorkloadAssumptions } from "./deployment-plan";

export type PriceWorkload = { region: string; assumptions: WorkloadAssumptions; serviceCount: number; managedDatabase: boolean; runtimeSecretCount?: number; database?: { engine: string; backup: boolean } | null };
type CostTemplate = { terraform: Record<string, unknown>; usage: Record<string, unknown>; categories: Record<string, string>; unknowns: Array<{category: string; reason: string}> };

// These documents are price previews only; Terraform never initializes, plans or applies them.
export function hostingCostTemplate(profile: HostingProfile, input: PriceWorkload): CostTemplate | null {
  if (!["ecs_fargate", "ec2", "lightsail"].includes(profile)) return null;
  const { assumptions: a, region, serviceCount } = input;
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region) || !Number.isInteger(serviceCount) || serviceCount < 1 || serviceCount > 20) throw new Error("Invalid price workload scope.");
  const p = a.pricing;
  const resource: Record<string, Record<string, any>> = {};
  const resource_usage: Record<string, unknown> = {};
  const categories: Record<string, string> = {};
  const unknowns: CostTemplate["unknowns"] = [];
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
    unknowns.push({ category: "storage", reason: "Root disk is included in the instance breakdown; backup retention and image storage require measured usage." });
  } else {
    const bundle = [{ id: "nano_3_0", cpu: 2, memory: 512 }, { id: "micro_3_0", cpu: 2, memory: 1024 }, { id: "small_3_0", cpu: 2, memory: 2048 }, { id: "medium_3_0", cpu: 2, memory: 4096 }, { id: "large_3_0", cpu: 2, memory: 8192 }].find((item) => item.cpu >= a.cpu * serviceCount && item.memory >= a.memoryMiB * serviceCount);
    if (!bundle) return null;
    add("aws_lightsail_instance", "application", { name: "pricing-preview", availability_zone: `${region}a`, blueprint_id: "amazon_linux_2023", bundle_id: bundle.id }, "compute");
    unknowns.push({ category: "network", reason: "The selected regional Lightsail bundle and included transfer allowance require provider verification." },
      { category: "storage", reason: "Bundle disk capacity, image storage and backup snapshots require provider verification." });
  }
  add("aws_cloudwatch_log_group", "application", { name: "pricing-preview", retention_in_days: 30 }, "monitoring", { storage_gb: a.monthlyLogGiB, monthly_data_ingested_gb: a.monthlyLogGiB, monthly_data_scanned_gb: 0 });
  resource_usage["aws_data_transfer.application"] = { region, monthly_outbound_internet_gb: a.monthlyTransferGiB, ...(p ? { monthly_intra_region_gb: p.monthlyIntraRegionGiB, monthly_outbound_us_east_to_us_east_gb: 0, monthly_outbound_other_regions_gb: 0 } : {}) };
  categories["aws_data_transfer.application"] = "data_transfer";
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
  return { terraform: { provider: { aws: { region } }, resource }, usage: { version: 0.1, resource_usage }, categories, unknowns };
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
  items.push({ category: "requests", monthlyUsd: 0, kind: "variable", reason: "This compute preview has no per-request compute tariff; load balancer request utilization is included in network pricing and remains blocked until resolved." });
  return { profile, region: input.region, source: "Infracost cloud pricing (infrastructure preview; no AWS resources created)", estimatedAt: new Date().toISOString(), assumptionsFingerprint: planFingerprint(input.assumptions), items };
}

@Injectable()
export class HostingPricingService {
  constructor(private readonly infracost: InfracostService, private readonly publicPricing?: AwsPublicPricingService) {}
  async estimate(input: PriceWorkload): Promise<HostingCost[]> {
    const costs: HostingCost[] = [];
    // Bound provider calls and temporary documents; secrets/source files never enter pricing.
    for (const profile of ["ecs_fargate", "ec2", "lightsail"] as const) {
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
        costs.push(cost);
      }
      catch { costs.push({ profile, region: input.region, source: "Infracost unavailable", estimatedAt: new Date().toISOString(), assumptionsFingerprint: planFingerprint(input.assumptions), items: [{ category: "compute", monthlyUsd: null, kind: "fixed", reason: "Current provider pricing could not be retrieved. Pricing must be completed before approval." }] }); }
      finally { await rm(workdir, { recursive: true, force: true }); }
    }
    return costs;
  }
}
