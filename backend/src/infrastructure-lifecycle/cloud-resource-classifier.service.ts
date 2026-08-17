import { Injectable } from "@nestjs/common";
import { InfrastructureEnvironmentStatus } from "../infrastructure/project-infrastructure-environment.entity";

export type DiscoveredCloudResource = {
  resourceKey: string;
  arn?: string | null;
  name: string;
  resourceType: string;
  awsService: string;
  region: string;
  tags?: Record<string, string>;
  source: "terraform" | "sdk" | "discovered_tag" | "naming_prefix" | "state_backend" | "unknown";
  projectId?: string | null;
  metadata?: Record<string, unknown>;
};

export type KnownProject = { id: string; name: string; infrastructureStatus?: string | null };

@Injectable()
export class CloudResourceClassifierService {
  private readonly cleanupTypes = new Set(["ecr_repository", "secret", "log_group", "ecs_service", "ecs_task", "ecs_task_definition", "ecs_cluster", "terraform_lockfile"]);
  private readonly highCostTypes = new Set(["nat_gateway", "load_balancer", "elastic_ip", "ecs_service", "ecs_task", "efs"]);
  private readonly protectedNames = new Set(["deployguard-state-bucket"]);

  classify(resource: DiscoveredCloudResource, projects: Map<string, KnownProject>) {
    const tagProjectId = this.uuid(resource.tags?.ProjectId) || this.uuid(resource.tags?.DeployGuardProjectId);
    const nameProjectId = this.projectIdFromName(resource.name);
    const projectId = tagProjectId || this.uuid(resource.projectId) || nameProjectId;
    const managedTag = resource.tags?.ManagedBy === "DeployGuard";
    const exactPrefix = Boolean(nameProjectId);
    const project = projectId ? projects.get(projectId) : undefined;
    const protectedResource = resource.awsService === "s3" && this.protectedNames.has(resource.name)
      || ["terraform_state", "terraform_state_backup", "state_bucket"].includes(resource.resourceType)
      || (resource.resourceType === "iam_role" && !projectId)
      || resource.metadata?.shared === true;
    const cleanupSupported = this.cleanupTypes.has(resource.resourceType);
    const registryOwnershipProof = resource.source === "terraform" && Boolean(projectId);
    const sdkOwnershipProof = resource.source === "sdk" && Boolean(projectId);
    const provablyDeployGuard = managedTag && Boolean(projectId) || exactPrefix || registryOwnershipProof || sdkOwnershipProof;
    const exactOrphan = exactPrefix && !project;
    const lockfileConfirmedStale = resource.resourceType !== "terraform_lockfile" || resource.metadata?.stale === true;
    const verifiedStateLock = resource.resourceType === "terraform_lockfile" && resource.source === "state_backend" && Boolean(projectId) && resource.metadata?.stale === true;
    const safeToCleanup = (managedTag && Boolean(projectId) || sdkOwnershipProof || exactOrphan || verifiedStateLock) && cleanupSupported && !protectedResource && lockfileConfirmedStale;
    const destroyed = [InfrastructureEnvironmentStatus.DESTROYED, InfrastructureEnvironmentStatus.DESTROY_NEEDS_CLEANUP, InfrastructureEnvironmentStatus.DESTROY_FAILED].includes(project?.infrastructureStatus as InfrastructureEnvironmentStatus);
    const status = protectedResource ? "protected"
      : !provablyDeployGuard ? "manual_review"
      : !project ? "orphan"
      : destroyed ? "cleanup_required"
      : "active";
    const source = managedTag ? "discovered_tag" : resource.source;
    const reason = protectedResource
      ? resource.metadata?.shared === true ? "Resource mapping is shared by multiple projects and is protected." : "Shared platform state or identity infrastructure is protected."
      : !provablyDeployGuard
        ? "Neither DeployGuard ownership tags nor an exact DeployGuard project prefix prove ownership."
        : resource.source === "terraform"
          ? "Terraform-managed resource. Run project-scoped Terraform destroy. Direct deletion is disabled to avoid dependency issues."
        : !cleanupSupported
          ? "Ownership is known, but automatic cleanup for this resource type is intentionally unsupported."
          : managedTag
            ? "ManagedBy=DeployGuard and an exact ProjectId tag prove project scope."
            : "An exact DeployGuard project naming prefix proves project scope.";
    return {
      ...resource,
      projectId: projectId || null,
      projectName: project?.name || null,
      source,
      status,
      costRisk: this.costRisk(resource.resourceType, resource.metadata),
      protected: protectedResource,
      cleanupSupported,
      safeToCleanup,
      reason,
    };
  }

  private costRisk(type: string, metadata?: Record<string, unknown>) {
    if (this.highCostTypes.has(type)) return "high";
    if (["ecr_repository", "log_group"].includes(type) && Number(metadata?.itemCount || metadata?.storedBytes || 0) > 20) return "high";
    if (["ecr_repository", "log_group", "backup", "target_group"].includes(type)) return "medium";
    if (["terraform_state", "terraform_lockfile", "ecs_task_definition", "iam_role", "iam_policy"].includes(type)) return "none";
    return "low";
  }

  private uuid(value?: string | null) { return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : null; }
  private projectIdFromName(value: string) {
    const match = value.match(/(?:^|[\/_-])([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:$|[\/_-])/i);
    if (!match) return null;
    return /(?:deployguard|\/deployguard\/|projects\/)/i.test(value) ? match[1].toLowerCase() : null;
  }
}
