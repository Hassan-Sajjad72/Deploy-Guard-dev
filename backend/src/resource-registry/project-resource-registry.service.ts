import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { CentralCloudResource } from "../infrastructure-lifecycle/central-cloud-resource.entity";

export type RegisterProjectResource = {
  projectId: string | null;
  pipelineRunId?: string | null;
  resourceType: string;
  awsService: string;
  region: string;
  resourceId: string;
  arn?: string | null;
  name: string;
  source: "terraform" | "sdk" | "discovered_tag" | "naming_prefix" | "state_backend" | "unknown";
  ownership: "project_owned" | "shared" | "orphan" | "unknown";
  cleanupEligibility?: "terraform_destroy" | "safe_cleanup" | "manual_review" | "protected";
  costRisk?: "none" | "low" | "medium" | "high";
  tags?: Record<string, string>;
  metadata?: Record<string, unknown>;
  status?: string;
  reason?: string;
};

@Injectable()
export class ProjectResourceRegistryService {
  constructor(@InjectRepository(CentralCloudResource) private readonly records: Repository<CentralCloudResource>) {}

  async register(input: RegisterProjectResource) {
    const now = new Date();
    const resourceKey = input.arn || `${input.awsService}:${input.region}:${input.resourceType}:${input.resourceId}`;
    let record = await this.records.findOne({ where: { resourceKey } });
    if (!record) record = this.records.create({ resourceKey, firstSeenAt: now });
    const protectedResource = input.cleanupEligibility === "protected" || input.ownership === "shared";
    Object.assign(record, {
      arn: input.arn || null,
      resourceName: input.name,
      resourceType: input.resourceType,
      awsService: input.awsService,
      region: input.region,
      projectId: input.projectId,
      // Inventory discovery must not transfer an existing resource to the
      // newest run. Only an explicit creator/apply path supplies a run id.
      pipelineRunId: input.pipelineRunId === undefined ? record.pipelineRunId || null : input.pipelineRunId,
      source: input.source,
      ownership: input.ownership,
      cleanupEligibility: input.cleanupEligibility || (protectedResource ? "protected" : "manual_review"),
      costRisk: input.costRisk || this.costRisk(input.resourceType),
      status: input.status || (protectedResource ? "protected" : "active"),
      safeToCleanup: input.cleanupEligibility === "safe_cleanup" && !protectedResource,
      cleanupSupported: input.cleanupEligibility === "safe_cleanup",
      protected: protectedResource,
      reason: input.reason || this.reason(input),
      tags: input.tags ? this.safeTags(input.tags) : record.tags || null,
      metadata: this.safeMetadata(input.metadata),
      lastSeenAt: now,
      deletedAt: null,
    });
    return this.records.save(record);
  }

  async registerTerraformOutputs(projectId: string, pipelineRunId: string, region: string, outputs: Record<string, unknown>) {
    const scalar: Array<[string, string, string, string]> = [
      ["vpc_id", "vpc", "ec2", "high"], ["internet_gateway_id", "internet_gateway", "ec2", "low"],
      ["public_route_table_id", "route_table", "ec2", "low"], ["private_route_table_id", "route_table", "ec2", "low"],
      ["alb_security_group_id", "security_group", "ec2", "low"], ["app_security_group_id", "security_group", "ec2", "low"], ["internal_security_group_id", "security_group", "ec2", "low"],
      ["cloud_map_namespace_id", "cloud_map_namespace", "servicediscovery", "low"], ["default_cloud_map_service_id", "cloud_map_service", "servicediscovery", "low"],
      ["efs_file_system_id", "efs", "elasticfilesystem", "high"], ["efs_access_point_id", "efs_access_point", "elasticfilesystem", "low"], ["efs_security_group_id", "security_group", "ec2", "low"],
      ["efs_kms_key_id", "kms_key", "kms", "none"], ["efs_backup_vault_name", "backup_vault", "backup", "medium"], ["efs_backup_plan_id", "backup_plan", "backup", "medium"],
      ["alb_arn", "load_balancer", "elasticloadbalancing", "high"], ["alb_target_group_arn", "target_group", "elasticloadbalancing", "medium"], ["alb_listener_arn", "listener", "elasticloadbalancing", "low"],
      ["ecs_cluster_arn", "ecs_cluster", "ecs", "low"], ["ecs_service_arn", "ecs_service", "ecs", "high"], ["ecs_task_definition_arn", "ecs_task_definition", "ecs", "none"],
      ["ecs_log_group_name", "log_group", "logs", "medium"], ["spot_event_rule_arn", "event_rule", "events", "low"], ["spot_event_log_group_name", "log_group", "logs", "medium"],
    ];
    const collections: Array<[string, string, string, string]> = [
      ["public_subnet_ids", "subnet", "ec2", "low"], ["private_subnet_ids", "subnet", "ec2", "low"], ["nat_gateway_ids", "nat_gateway", "ec2", "high"], ["efs_mount_target_ids", "efs_mount_target", "elasticfilesystem", "medium"],
    ];
    const tags = { ManagedBy: "DeployGuard", ProjectId: projectId, PipelineRunId: pipelineRunId, Environment: "dev" };
    for (const [key, resourceType, awsService, costRisk] of scalar) {
      const value = this.value(outputs[key]);
      if (!value) continue;
      await this.register({ projectId, pipelineRunId, resourceType, awsService, region, resourceId: value, arn: value.startsWith("arn:") ? value : null, name: value, source: "terraform", ownership: "project_owned", cleanupEligibility: "terraform_destroy", costRisk: costRisk as any, tags, metadata: { terraformOutput: key } });
    }
    for (const [key, resourceType, awsService, costRisk] of collections) {
      for (const value of Array.isArray(outputs[key]) ? outputs[key] as unknown[] : []) {
        const id = this.value(value); if (!id) continue;
        await this.register({ projectId, pipelineRunId, resourceType, awsService, region, resourceId: id, name: id, source: "terraform", ownership: "project_owned", cleanupEligibility: "terraform_destroy", costRisk: costRisk as any, tags, metadata: { terraformOutput: key } });
      }
    }
  }

  async listProject(projectId: string) {
    return this.records.find({ where: { projectId }, order: { lastSeenAt: "DESC" } });
  }

  async markDeleted(resourceKey: string) {
    const record = await this.records.findOne({ where: { resourceKey } });
    if (!record) return;
    record.status = "deleted"; record.deletedAt = new Date(); record.safeToCleanup = false;
    await this.records.save(record);
  }

  async markTerraformDestroyCompleted(projectId: string, pipelineRunId?: string | null) {
    const records = await this.records.find({ where: { projectId, cleanupEligibility: "terraform_destroy" } });
    const now = new Date();
    for (const record of records) {
      if (record.status === "deleted" || (pipelineRunId && record.pipelineRunId && record.pipelineRunId !== pipelineRunId)) continue;
      record.status = "deleted"; record.deletedAt = now; record.safeToCleanup = false;
    }
    if (records.length) await this.records.save(records);
  }

  private value(value: unknown) { return value === undefined || value === null || value === "" ? null : String(value); }
  private safeTags(tags?: Record<string, string>) { return tags ? Object.fromEntries(Object.entries(tags).filter(([key]) => !/secret|token|password|credential|access.?key/i.test(key)).map(([key, value]) => [key.slice(0, 128), String(value).slice(0, 256)])) : null; }
  private safeMetadata(metadata?: Record<string, unknown>) { return metadata ? Object.fromEntries(Object.entries(metadata).filter(([key]) => !/secret|token|password|credential|environment/i.test(key))) : null; }
  private costRisk(type: string): "none" | "low" | "medium" | "high" { if (["nat_gateway", "load_balancer", "ecs_service", "ecs_task", "efs"].includes(type)) return "high"; if (["ecr_repository", "log_group", "backup_vault", "backup_plan", "target_group"].includes(type)) return "medium"; if (["terraform_state", "terraform_lockfile", "ecs_task_definition", "iam_role", "iam_policy", "kms_key"].includes(type)) return "none"; return "low"; }
  private reason(input: RegisterProjectResource) { return input.ownership === "shared" ? "Shared platform resource; automatic cleanup is forbidden." : input.source === "terraform" ? "Terraform-managed resource. Run project-scoped Terraform destroy. Direct deletion is disabled to avoid dependency issues." : input.source === "sdk" ? "Created by a DeployGuard SDK operation for this project." : "Discovered resource awaiting ownership classification."; }
}
