import { createHash } from "node:crypto";
import { CanonicalBuildTarget } from "../projects/build-target";
import { RequirementAdmission } from "../projects/deployment-requirement-resolver.service";
import { ApplicationDependency } from "./application-dependencies";

export const HOSTING_PROFILES = ["ecs_fargate", "ec2", "lightsail", "lambda", "static"] as const;
export type HostingProfile = typeof HOSTING_PROFILES[number];
export type WorkloadPricingQuantities = { imageStorageGiB: number; publicIpv4Count: number; albNewConnectionsPerSecond: number; albActiveConnectionsPerMinute: number; albRuleEvaluationsPerSecond: number; monthlyIntraRegionGiB: number; stateStorageGiB: number; monthlyStateWriteRequests: number; monthlyStateReadRequests: number; monthlySecretApiRequests: number; backupStorageGiB: number; averageRequestDurationMs?: number };
export type WorkloadAssumptions = {
  cpu: number; memoryMiB: number; storageGiB: number; replicas: number;
  monthlyRequests: number; monthlyTransferGiB: number; monthlyLogGiB: number;
  availability: "single_instance" | "multi_zone"; stateful: boolean;
  continuousCompute: boolean; monthlyBudgetUsd: number; pricing?: WorkloadPricingQuantities;
};
export type HostingCost = {
  profile: HostingProfile; region: string; source: string; estimatedAt: string;
  assumptionsFingerprint: string; items: Array<{ category: string; monthlyUsd: number | null; kind: "fixed" | "variable"; reason: string }>;
};
export function planFingerprint(value: unknown): string {
  const canonical = (item: any): any => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

// Customer execution is unavailable until profile-specific ownership and AWS verification exists.
export const hostingCatalog = HOSTING_PROFILES.map((id) => ({ id, available: false,
  implementation: id === "ecs_fargate" ? "existing_control_plane_workflow" : "not_implemented",
  reason: id === "ecs_fargate" ? "Customer-account execution and region verification are incomplete." : "Deployment, rollback, cleanup and real-provider verification are incomplete.",
}));

export type HostingProfileAvailability = { id: HostingProfile; available: boolean; implementation: string; reason: string; verification?: { status: string; fingerprint?: string; [key: string]: unknown } };

/** Build kinds from server-merged, sealed profile inputs; anything unverified proves nothing. */
export function verifiedBuildKinds(inputs: Record<string, unknown> | undefined | null): string[] {
  const build = inputs?.build as { status?: unknown; kind?: unknown } | undefined;
  return build?.status === "verified" && typeof build.kind === "string" ? [build.kind] : [];
}

/** IAM policy names are unique per account regardless of path, so each project's ECS task-role boundary carries its project ID. */
export const ecsTaskBoundaryArn = (accountId: string, projectId: string) => `arn:aws:iam::${accountId}:policy/deployguard/${projectId}/ecs-task-boundary-${projectId}`;

export function compareHosting(input: {
  region: string; assumptions: WorkloadAssumptions; targets: CanonicalBuildTarget[];
  managedDatabase: boolean; requirements: RequirementAdmission;
  // Unknown configuration counts block serverless profiles rather than assuming none exist.
  configuration?: { references: number; secrets: number };
  dependencies?: ApplicationDependency[];
  // Kinds of verified, sandboxed hosting builds for this source ("static", "lambda_http", ...).
  verifiedBuildKinds?: string[];
}, costs: HostingCost[] = [], profiles: HostingProfileAvailability[] = hostingCatalog) {
  const assumptionsFingerprint = planFingerprint(input.assumptions);
  const options = profiles.map((profile) => {
    const reasons: string[] = [];
    if (!input.targets.length || input.targets.some((target) => target.status !== "resolved")) reasons.push("An exact-SHA resolved build target is required for every service.");
    if (input.requirements.status !== "READY") reasons.push("Required application configuration is missing or blocked.");
    if (profile.id === "ecs_fargate") {
      if (input.assumptions.pricing && input.assumptions.pricing.publicIpv4Count < input.targets.length * (2 + input.assumptions.replicas) + (input.managedDatabase ? 1 : 0)) reasons.push("Public IPv4 quantities must cover each application task, two ALB addresses per service and the database task.");
      const memoryRanges: Record<number, [number, number, number]> = { .25: [512, 2048, 512], .5: [1024, 4096, 1024], 1: [2048, 8192, 1024], 2: [4096, 16384, 1024], 4: [8192, 30720, 1024], 8: [16384, 61440, 4096], 16: [32768, 122880, 8192] };
      const memory = memoryRanges[input.assumptions.cpu];
      if (!memory || (input.assumptions.cpu === .25 ? ![512, 1024, 2048].includes(input.assumptions.memoryMiB) : input.assumptions.memoryMiB < memory[0] || input.assumptions.memoryMiB > memory[1] || (input.assumptions.memoryMiB - memory[0]) % memory[2] !== 0)) reasons.push("The requested CPU/memory combination is unsupported by the Fargate Linux task contract.");
      if (input.assumptions.stateful && !input.managedDatabase) reasons.push("Persistent application storage has not been mapped to a verified Fargate persistence contract.");
      if (input.assumptions.availability === "multi_zone" && (input.assumptions.replicas < 2 || input.managedDatabase)) reasons.push("Multi-zone availability requires multiple application replicas and a verified database availability contract.");
    }
    // These mirror the sealed artifact builders so incompatible plans are rejected before approval, not at execution.
    if (profile.id === "static" || profile.id === "lambda") {
      const label = profile.id === "static" ? "Static hosting" : "Lambda";
      if (input.targets.length !== 1) reasons.push(`${label} supports exactly one deployable service.`);
      if (input.assumptions.stateful || input.managedDatabase) reasons.push(`${label} cannot retain application state or attach a database.`);
      if (input.assumptions.continuousCompute) reasons.push(`${label} cannot satisfy continuously running compute.`);
      if (!input.configuration) reasons.push(`${label} requires resolved runtime configuration references.`);
      else if (profile.id === "static" && input.configuration.references > 0) reasons.push("Static hosting cannot provide server runtime configuration.");
      else if (profile.id === "lambda" && input.configuration.secrets > 0) reasons.push("Lambda secret resolution is not yet verified; remove runtime secrets or choose another profile.");
      if (profile.id === "lambda" && (input.assumptions.memoryMiB < 128 || input.assumptions.memoryMiB > 10240)) reasons.push("Lambda memory must be between 128 and 10240 MiB.");
      // Framework detection (e.g. Vite) cannot prove the workload has no server; only a verified build output can.
      if (profile.id === "static" && !input.verifiedBuildKinds?.includes("static")) reasons.push("Verified static build output is required: run a static build that produces index.html before static hosting is eligible.");
      if (profile.id === "lambda" && !input.verifiedBuildKinds?.includes("lambda_http")) reasons.push("A verified Lambda HTTP handler build is required before Lambda is eligible.");
    }
    if (profile.id === "lightsail" && (input.assumptions.availability === "multi_zone" || input.assumptions.replicas !== 1 || input.targets.length !== 1 || input.managedDatabase)) reasons.push("This workload requires an unimplemented Lightsail multi-service, persistence or availability contract.");
    if (profile.id === "ec2" && input.assumptions.availability === "multi_zone") reasons.push("A verified multi-zone EC2 scaling contract is required.");
    const warnings: string[] = [];
    for (const dependency of input.dependencies || []) {
      if (dependency.provisioning !== "customer_supplied") continue;
      if (profile.id === "lambda" && dependency.privateNetworkLikely) warnings.push(`The Lambda HTTP adapter has no VPC attachment; ${dependency.name} must be reachable over a public, authenticated endpoint.`);
      if ((profile.id === "ec2" || profile.id === "lightsail") && dependency.kind === "cache") warnings.push(`${dependency.name} is not provisioned by DeployGuard; supply a managed endpoint reachable from the instance.`);
    }
    const cost = costs.find((item) => item.profile === profile.id && item.region === input.region && item.assumptionsFingerprint === assumptionsFingerprint);
    const requiredCategories = ["compute", "network", "storage", "data_transfer", "monitoring", "requests", ...(input.managedDatabase ? ["database"] : [])];
    const freshCost = cost && Number.isFinite(Date.parse(cost.estimatedAt)) && Date.now() - Date.parse(cost.estimatedAt) >= 0 && Date.now() - Date.parse(cost.estimatedAt) <= 24 * 60 * 60 * 1000;
    const complete = Boolean(freshCost && cost.source.trim() && requiredCategories.every((category) => cost.items.some((item) => item.category === category)) && cost.items.length && cost.items.every((item) => typeof item.monthlyUsd === "number" && Number.isFinite(item.monthlyUsd) && item.monthlyUsd >= 0));
    const monthlyUsd = complete ? cost!.items.reduce((sum, item) => sum + item.monthlyUsd!, 0) : null;
    const compatible = reasons.length === 0;
    if (!complete) reasons.push("Complete, current, itemized pricing for this workload is unavailable.");
    if (monthlyUsd !== null && monthlyUsd > input.assumptions.monthlyBudgetUsd) reasons.push("Estimated total monthly cost exceeds the approved budget.");
    if (!profile.available) reasons.push(profile.reason);
    return { ...profile, compatible, eligible: reasons.length === 0, reasons, warnings,
      cost: { status: complete ? "complete" : "incomplete", monthlyUsd, currency: "USD", source: cost?.source || null, estimatedAt: cost?.estimatedAt || null,
        items: [...(cost?.items || []), ...requiredCategories.filter((category) => !cost?.items.some((item) => item.category === category)).map((category) => ({ category, monthlyUsd: null, kind: ["data_transfer", "monitoring", "requests"].includes(category) ? "variable" : "fixed", reason: "A verified workload-specific price is required." }))] },
      tradeoffs: profile.id === "ecs_fargate" ? ["Managed container scheduling", "Load balancer and network charges apply"]
        : profile.id === "ec2" || profile.id === "lightsail" ? ["Guest OS patching and restart management required", "Instance rental alone is not total cost"]
          : profile.id === "lambda" ? ["Invocation and execution limits", "Request and integration charges apply"] : ["Static artifacts only", "CDN requests and transfer charges apply"],
    };
  });
  const eligible = options.filter((option) => option.eligible).sort((a, b) => a.cost.monthlyUsd! - b.cost.monthlyUsd!);
  return { status: eligible.length ? "eligible" : "no_eligible_profile", recommendedProfile: eligible[0]?.id || null, assumptionsFingerprint, options,
    recommendation: recommendationExplanation(eligible, input.assumptions) };
}

const operationalAdvantages: Record<HostingProfile, string> = {
  ecs_fargate: "managed container scheduling without guest OS patching, and the existing multi-service rollback path",
  ec2: "persistent compute with full instance control",
  lightsail: "bundled transfer allowance and a simple fixed monthly plan",
  lambda: "no idle compute charges and automatic request scaling",
  static: "no application compute to operate or patch",
};

// FR-123: the cheapest eligible option wins on cost; costlier eligible options state what the extra spend buys.
function recommendationExplanation(eligible: Array<{ id: HostingProfile; cost: { monthlyUsd: number | null } }>, assumptions: WorkloadAssumptions) {
  if (!eligible.length) return { summary: "No hosting profile is both compatible and within the approved budget. Review each option's reasons.", alternatives: [] };
  const [best, ...rest] = eligible;
  const basis = `${assumptions.replicas} replica(s), ${assumptions.cpu} vCPU, ${assumptions.memoryMiB} MiB, ${assumptions.monthlyRequests} requests and ${assumptions.monthlyTransferGiB} GiB transfer per month, ${assumptions.availability === "multi_zone" ? "multi-zone" : "single-instance"} availability`;
  return {
    summary: `${best.id} has the lowest estimated total monthly cost (${best.cost.monthlyUsd!.toFixed(2)} USD) among eligible options for the same workload: ${basis}.`,
    alternatives: rest.map((option) => ({ profile: option.id, additionalMonthlyUsd: Number((option.cost.monthlyUsd! - best.cost.monthlyUsd!).toFixed(2)),
      advantage: `Costs ${(option.cost.monthlyUsd! - best.cost.monthlyUsd!).toFixed(2)} USD more per month; offers ${operationalAdvantages[option.id]}.` })),
  };
}

export type DeploymentPlanContent = {
  projectId?: string; generationId?: string; profileInputs?: Record<string, unknown>;
  contractVersion: "deployguard.deployment-plan/v1"; operationId: string;
  ownership: { organizationId: string; clientId?: string | null; engagementId?: string | null; bindingId: string; accountId: string; roleArn: string; bindingVersion: number; region: string; environment: string };
  repository: { url: string; fullName: string; branch: string; sourceSha: string };
  deploymentAction?: "deploy" | "rollback" | "destroy";
  retry?: { failedOperationId: string; failureFingerprint: string };
  lifecycle?: { action: "rollback" | "destroy"; targetOperationId: string; targetReleaseId: string; targetGenerationId: string; targetFingerprint: string; liveGenerationId: string };
  configurationFingerprint: string; assumptions: WorkloadAssumptions; selectedProfile: HostingProfile;
  infrastructure?: { vpcId: string; publicSubnetIds: string[]; terraformStateBucket: string; executionRolePermissionsBoundaryArn?: string } | null;
  services: Array<{ id: string; name: string; directory: string; port: number; buildTarget: CanonicalBuildTarget }>;
  environmentReferences: Array<{ id: string; serviceId: string; key: string; scope: string; isSecret: boolean; fingerprint: string | null }>;
  dependencies: { database: { provider: string; engine: string | null; attachedServiceId: string | null; persistence: boolean; backup: boolean } | null; services?: ApplicationDependency[] };
  requirements: RequirementAdmission; comparison: ReturnType<typeof compareHosting>;
  securityFindings: Array<{ status: string; reason: string }>;
  status: "blocked" | "review_required"; blockers: string[]; risks: string[];
};
