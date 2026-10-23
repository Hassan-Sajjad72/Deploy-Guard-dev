import { createHash } from "node:crypto";
import { CanonicalBuildTarget } from "../projects/build-target";
import { RequirementAdmission } from "../projects/deployment-requirement-resolver.service";

export const HOSTING_PROFILES = ["ecs_fargate", "ec2", "lightsail", "lambda", "static"] as const;
export type HostingProfile = typeof HOSTING_PROFILES[number];
export type WorkloadAssumptions = {
  cpu: number; memoryMiB: number; storageGiB: number; replicas: number;
  monthlyRequests: number; monthlyTransferGiB: number; monthlyLogGiB: number;
  availability: "single_instance" | "multi_zone"; stateful: boolean;
  continuousCompute: boolean; monthlyBudgetUsd: number;
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

export function compareHosting(input: {
  region: string; assumptions: WorkloadAssumptions; targets: CanonicalBuildTarget[];
  managedDatabase: boolean; requirements: RequirementAdmission;
}, costs: HostingCost[] = []) {
  const assumptionsFingerprint = planFingerprint(input.assumptions);
  const options = hostingCatalog.map((profile) => {
    const reasons: string[] = [];
    if (!input.targets.length || input.targets.some((target) => target.status !== "resolved")) reasons.push("An exact-SHA resolved build target is required for every service.");
    if (input.requirements.status !== "READY") reasons.push("Required application configuration is missing or blocked.");
    if (profile.id === "ecs_fargate") {
      const memoryRanges: Record<number, [number, number, number]> = { .25: [512, 2048, 512], .5: [1024, 4096, 1024], 1: [2048, 8192, 1024], 2: [4096, 16384, 1024], 4: [8192, 30720, 1024], 8: [16384, 61440, 4096], 16: [32768, 122880, 8192] };
      const memory = memoryRanges[input.assumptions.cpu];
      if (!memory || (input.assumptions.cpu === .25 ? ![512, 1024, 2048].includes(input.assumptions.memoryMiB) : input.assumptions.memoryMiB < memory[0] || input.assumptions.memoryMiB > memory[1] || (input.assumptions.memoryMiB - memory[0]) % memory[2] !== 0)) reasons.push("The requested CPU/memory combination is unsupported by the Fargate Linux task contract.");
      if (input.assumptions.stateful && !input.managedDatabase) reasons.push("Persistent application storage has not been mapped to a verified Fargate persistence contract.");
      if (input.assumptions.availability === "multi_zone" && (input.assumptions.replicas < 2 || input.managedDatabase)) reasons.push("Multi-zone availability requires multiple application replicas and a verified database availability contract.");
    }
    if (profile.id === "static") reasons.push("Verified static build artifacts and absence of server runtime dependencies have not been established.");
    if (profile.id === "lambda") reasons.push("A verified Lambda adapter, invocation limits and dependency contract are required.");
    if (profile.id === "lightsail" && (input.assumptions.availability === "multi_zone" || input.assumptions.replicas !== 1 || input.targets.length !== 1 || input.managedDatabase)) reasons.push("This workload requires an unimplemented Lightsail multi-service, persistence or availability contract.");
    if (profile.id === "ec2" && input.assumptions.availability === "multi_zone") reasons.push("A verified multi-zone EC2 scaling contract is required.");
    const cost = costs.find((item) => item.profile === profile.id && item.region === input.region && item.assumptionsFingerprint === assumptionsFingerprint);
    const requiredCategories = ["compute", "network", "storage", "data_transfer", "monitoring", "requests", ...(input.managedDatabase ? ["database"] : [])];
    const freshCost = cost && Number.isFinite(Date.parse(cost.estimatedAt)) && Date.now() - Date.parse(cost.estimatedAt) >= 0 && Date.now() - Date.parse(cost.estimatedAt) <= 24 * 60 * 60 * 1000;
    const complete = Boolean(freshCost && cost.source.trim() && requiredCategories.every((category) => cost.items.some((item) => item.category === category)) && cost.items.length && cost.items.every((item) => typeof item.monthlyUsd === "number" && Number.isFinite(item.monthlyUsd) && item.monthlyUsd >= 0));
    const monthlyUsd = complete ? cost!.items.reduce((sum, item) => sum + item.monthlyUsd!, 0) : null;
    const compatible = reasons.length === 0;
    if (!complete) reasons.push("Complete, current, itemized pricing for this workload is unavailable.");
    if (monthlyUsd !== null && monthlyUsd > input.assumptions.monthlyBudgetUsd) reasons.push("Estimated total monthly cost exceeds the approved budget.");
    if (!profile.available) reasons.push(profile.reason);
    return { ...profile, compatible, eligible: reasons.length === 0, reasons,
      cost: { status: complete ? "complete" : "incomplete", monthlyUsd, currency: "USD", source: cost?.source || null, estimatedAt: cost?.estimatedAt || null,
        items: [...(cost?.items || []), ...requiredCategories.filter((category) => !cost?.items.some((item) => item.category === category)).map((category) => ({ category, monthlyUsd: null, kind: ["data_transfer", "monitoring", "requests"].includes(category) ? "variable" : "fixed", reason: "A verified workload-specific price is required." }))] },
      tradeoffs: profile.id === "ecs_fargate" ? ["Managed container scheduling", "Load balancer and network charges apply"]
        : profile.id === "ec2" || profile.id === "lightsail" ? ["Guest OS patching and restart management required", "Instance rental alone is not total cost"]
          : profile.id === "lambda" ? ["Invocation and execution limits", "Request and integration charges apply"] : ["Static artifacts only", "CDN requests and transfer charges apply"],
    };
  });
  const eligible = options.filter((option) => option.eligible).sort((a, b) => a.cost.monthlyUsd! - b.cost.monthlyUsd!);
  return { status: eligible.length ? "eligible" : "no_eligible_profile", recommendedProfile: eligible[0]?.id || null, assumptionsFingerprint, options };
}

export type DeploymentPlanContent = {
  contractVersion: "deployguard.deployment-plan/v1"; operationId: string;
  ownership: { organizationId: string; clientId?: string | null; engagementId?: string | null; bindingId: string; accountId: string; roleArn: string; bindingVersion: number; region: string; environment: string };
  repository: { url: string; fullName: string; branch: string; sourceSha: string };
  configurationFingerprint: string; assumptions: WorkloadAssumptions; selectedProfile: HostingProfile;
  infrastructure?: { vpcId: string; publicSubnetIds: string[]; terraformStateBucket: string } | null;
  services: Array<{ id: string; name: string; directory: string; port: number; buildTarget: CanonicalBuildTarget }>;
  environmentReferences: Array<{ id: string; serviceId: string; key: string; scope: string; isSecret: boolean; fingerprint: string | null }>;
  dependencies: { database: { provider: string; engine: string | null; attachedServiceId: string | null; persistence: boolean; backup: boolean } | null };
  requirements: RequirementAdmission; comparison: ReturnType<typeof compareHosting>;
  securityFindings: Array<{ status: string; reason: string }>;
  status: "blocked" | "review_required"; blockers: string[]; risks: string[];
};
