import { Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { ProjectInfrastructureEnvironment } from "../infrastructure/project-infrastructure-environment.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { Project } from "../projects/project.entity";
import { AwsCliService } from "../state-management/aws-cli.service";
import { TerraformStateService } from "../state-management/terraform-state.service";
import { User } from "../users/user.entity";
import { ProjectResourceRegistryService } from "../resource-registry/project-resource-registry.service";
import { CloudInventoryScan } from "./cloud-inventory-scan.entity";
import { DestroyOperation } from "./destroy-operation.entity";

export type ProjectCloudResource = {
  id: string;
  arn: string | null;
  name: string;
  category: string;
  source: "tags" | "deployment_mapping" | "state_backend";
  projectScoped: boolean;
  protected: boolean;
  cleanupSupported: boolean;
  risk: "low" | "medium" | "high";
  costRisk: "none" | "low" | "medium" | "high";
  deleteStatus: "found" | "protected";
  reason: string;
  metadata?: Record<string, unknown>;
  awsService?: string;
  region?: string;
  pipelineRunId?: string | null;
  ownership?: "project_owned" | "shared" | "unknown";
  cleanupEligibility?: "terraform_destroy" | "safe_cleanup" | "manual_review" | "protected";
};

type AwsTagMapping = { ResourceARN?: string; Tags?: Array<{ Key?: string; Value?: string }> };

@Injectable()
export class ProjectCloudInventoryService {
  constructor(
    @InjectRepository(Project) private readonly projects: Repository<Project>,
    @InjectRepository(ProjectPipelineRun) private readonly runs: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectInfrastructureEnvironment) private readonly environments: Repository<ProjectInfrastructureEnvironment>,
    @InjectRepository(CloudInventoryScan) private readonly scans: Repository<CloudInventoryScan>,
    @InjectRepository(DestroyOperation) private readonly destroyOperations: Repository<DestroyOperation>,
    private readonly aws: AwsCliService,
    private readonly terraformState: TerraformStateService,
    private readonly config: ConfigService,
    private readonly audit: AuditLogService,
    private readonly registry: ProjectResourceRegistryService,
  ) {}

  async scan(projectId: string, actorUser?: User | null, operationId?: string | null) {
    const startedAt = new Date();
    const project = await this.projects.findOne({ where: { id: projectId } });
    if (!project) throw new NotFoundException("Project not found.");
    const [environment, latestRun, runs] = await Promise.all([
      this.environments.findOne({ where: { projectId }, order: { updatedAt: "DESC" } }),
      this.runs.findOne({ where: { projectId }, order: { createdAt: "DESC" } }),
      this.runs.find({ where: { projectId }, order: { createdAt: "DESC" }, take: 100 }),
    ]);
    await this.audit.record({ actorUser, action: "PROJECT_CLOUD_INVENTORY_STARTED", resourceType: "project", resourceId: projectId, status: "success", metadata: { projectId, operationId: operationId || null } });

    const warnings: string[] = [];
    const resources = new Map<string, ProjectCloudResource>();
    for (const tagKey of ["ProjectId", "DeployGuardProjectId"]) {
      const payload = await this.tryJson([
        "resourcegroupstaggingapi", "get-resources", "--tag-filters",
        "Key=ManagedBy,Values=DeployGuard", `Key=${tagKey},Values=${projectId}`, "--output", "json",
      ], warnings, `Tagged-resource discovery (${tagKey})`);
      for (const mapping of (payload.ResourceTagMappingList || []) as AwsTagMapping[]) {
        const arn = String(mapping.ResourceARN || "");
        if (!arn) continue;
        const tags = Object.fromEntries((mapping.Tags || []).map((tag) => [String(tag.Key || ""), String(tag.Value || "")]));
        const exactScope = tags.ManagedBy === "DeployGuard" && (tags.ProjectId === projectId || tags.DeployGuardProjectId === projectId);
        if (!exactScope) continue;
        this.add(resources, this.resourceFromArn(arn, "tags", true));
      }
    }

    const repositoryNames = [...new Set(runs.map((run) => run.ecrRepositoryName).filter((value): value is string => Boolean(value)))];
    for (const repositoryName of repositoryNames) {
      if (!this.safeRepositoryName(repositoryName)) continue;
      const repositoryOwners = await this.runs.createQueryBuilder("run").select("DISTINCT run.projectId", "projectId").where("run.ecrRepositoryName = :repositoryName", { repositoryName }).getRawMany<{ projectId: string }>();
      const shared = repositoryOwners.some((owner) => owner.projectId !== projectId);
      const payload = await this.tryJson(["ecr", "describe-repositories", "--repository-names", repositoryName, "--output", "json"], warnings, `ECR repository ${repositoryName}`, true);
      const repository = Array.isArray(payload.repositories) ? payload.repositories[0] : null;
      if (repository?.repositoryArn) {
        const resource = this.mappedResource(String(repository.repositoryArn), repositoryName, "ecr_repository", !shared, shared ? "Repository is mapped to more than one project and is protected from automatic deletion." : "Exact repository name recorded only by this project's pipeline runs.");
        resource.protected = shared; resource.deleteStatus = shared ? "protected" : "found";
        this.add(resources, resource);
        const images = await this.tryJson(["ecr", "describe-images", "--repository-name", repositoryName, "--max-items", "100", "--output", "json"], warnings, `ECR images for ${repositoryName}`, true);
        for (const image of images.imageDetails || []) { const digest = String(image.imageDigest || ""); if (!digest) continue; const tags = Array.isArray(image.imageTags) ? image.imageTags.map(String) : []; const child = this.mappedResource(`${repository.repositoryArn}@${digest}`, tags[0] || digest.slice(0, 20), "ecr_image", false, "Image is deleted with its project ECR repository."); child.metadata = { repositoryName, digest, tags, pushedAt: image.imagePushedAt || null, sizeBytes: image.imageSizeInBytes || null }; child.protected = shared; if (shared) child.deleteStatus = "protected"; this.add(resources, child); }
        const lifecycle = await this.tryJson(["ecr", "get-lifecycle-policy", "--repository-name", repositoryName, "--output", "json"], warnings, `ECR lifecycle policy for ${repositoryName}`, true);
        if (lifecycle.lifecyclePolicyText) { const policy = this.mappedResource(`${repository.repositoryArn}:lifecycle-policy`, `${repositoryName} lifecycle policy`, "ecr_lifecycle_policy", false, "Lifecycle policy is deleted with its project ECR repository."); policy.protected = shared; if (shared) policy.deleteStatus = "protected"; this.add(resources, policy); }
      }
    }

    const secretPrefix = `deployguard/${projectId}/`;
    const secrets = await this.tryJson(["secretsmanager", "list-secrets", "--filters", `Key=name,Values=${secretPrefix}`, "--output", "json"], warnings, "Secrets Manager discovery");
    for (const secret of (secrets.SecretList || []) as Array<{ ARN?: string; Name?: string }>) {
      const name = String(secret.Name || "");
      if (name.startsWith(secretPrefix)) this.add(resources, this.mappedResource(String(secret.ARN || name), name, "secret", true, "DeployGuard project secret name prefix matched exactly."));
    }

    const logPrefix = `/deployguard/${projectId}/`;
    const logs = await this.tryJson(["logs", "describe-log-groups", "--log-group-name-prefix", logPrefix, "--output", "json"], warnings, "CloudWatch log discovery");
    for (const group of (logs.logGroups || []) as Array<{ arn?: string; logGroupArn?: string; logGroupName?: string }>) {
      const name = String(group.logGroupName || "");
      if (name.startsWith(logPrefix)) { this.add(resources, this.mappedResource(String(group.logGroupArn || group.arn || name), name, "log_group", true, "DeployGuard project log-group prefix matched exactly.")); const streams = await this.tryJson(["logs", "describe-log-streams", "--log-group-name", name, "--order-by", "LastEventTime", "--descending", "--max-items", "100", "--output", "json"], warnings, `CloudWatch streams for ${name}`, true); for (const stream of streams.logStreams || []) { const streamName = String(stream.logStreamName || ""); if (!streamName) continue; const child = this.mappedResource(`${name}:stream:${streamName}`, streamName, "log_stream", false, "Log stream is deleted with its project log group."); child.metadata = { logGroupName: name, lastEventTimestamp: stream.lastEventTimestamp || null }; this.add(resources, child); } }
    }

    const taskFamily = `dg-${projectId.replace(/-/g, "").slice(0, 20)}-`;
    const taskDefinitions = await this.tryJson(["ecs", "list-task-definitions", "--family-prefix", taskFamily, "--status", "ACTIVE", "--output", "json"], warnings, "ECS task-definition discovery");
    for (const arn of (taskDefinitions.taskDefinitionArns || []) as string[]) {
      if (this.taskFamily(arn).startsWith(taskFamily)) this.add(resources, this.mappedResource(arn, this.taskFamily(arn), "ecs_task_definition", true, "ECS family prefix is derived from this project ID."));
    }

    const outputs = environment?.terraformOutputs || {};
    const albArn = this.outputString(outputs, "alb_arn");
    const targetGroupArn = this.outputString(outputs, "alb_target_group_arn");
    const listenerArn = this.outputString(outputs, "alb_listener_arn");
    if (albArn) {
      const value = await this.tryJson(["elbv2", "describe-load-balancers", "--load-balancer-arns", albArn, "--output", "json"], warnings, "Mapped ALB", true);
      if (value.LoadBalancers?.length) this.add(resources, this.mappedResource(albArn, this.arnName(albArn), "load_balancer", false, "Exact ALB ARN persisted from this project's Terraform outputs."));
    }
    if (targetGroupArn) {
      const value = await this.tryJson(["elbv2", "describe-target-groups", "--target-group-arns", targetGroupArn, "--output", "json"], warnings, "Mapped target group", true);
      if (value.TargetGroups?.length) this.add(resources, this.mappedResource(targetGroupArn, this.arnName(targetGroupArn), "target_group", false, "Exact target-group ARN persisted from this project's Terraform outputs."));
    }
    if (listenerArn) {
      const value = await this.tryJson(["elbv2", "describe-listeners", "--listener-arns", listenerArn, "--output", "json"], warnings, "Mapped ALB listener", true);
      if (value.Listeners?.length) this.add(resources, this.mappedResource(listenerArn, this.arnName(listenerArn), "listener", false, "Exact listener ARN persisted from this project's Terraform outputs."));
    }
    const clusterArn = this.outputString(outputs, "ecs_cluster_arn");
    const serviceArn = this.outputString(outputs, "ecs_service_arn");
    if (clusterArn) {
      const value = await this.tryJson(["ecs", "describe-clusters", "--clusters", clusterArn, "--output", "json"], warnings, "Mapped ECS cluster", true);
      if (value.clusters?.some((cluster: { status?: string }) => cluster.status !== "INACTIVE")) this.add(resources, this.mappedResource(clusterArn, this.arnName(clusterArn), "ecs_cluster", false, "Exact ECS cluster ARN persisted from this project's Terraform outputs."));
    }
    if (clusterArn && serviceArn) {
      const value = await this.tryJson(["ecs", "describe-services", "--cluster", clusterArn, "--services", serviceArn, "--output", "json"], warnings, "Mapped ECS service", true);
      if (value.services?.some((service: { status?: string }) => service.status !== "INACTIVE")) this.add(resources, this.mappedResource(serviceArn, this.arnName(serviceArn), "ecs_service", false, "Exact ECS service ARN persisted from this project's Terraform outputs."));
      const tasks = await this.tryJson(["ecs", "list-tasks", "--cluster", clusterArn, "--service-name", serviceArn, "--output", "json"], warnings, "Mapped ECS tasks", true);
      for (const taskArn of tasks.taskArns || []) this.add(resources, this.mappedResource(String(taskArn), this.arnName(String(taskArn)), "ecs_task", false, "Running task belongs to the exact mapped project service."));
    }
    const efsId = this.outputString(outputs, "efs_file_system_id");
    if (efsId) {
      const value = await this.tryJson(["efs", "describe-file-systems", "--file-system-id", efsId, "--output", "json"], warnings, "Mapped EFS file system", true);
      if (value.FileSystems?.length) this.add(resources, this.mappedResource(this.outputString(outputs, "efs_file_system_arn") || efsId, efsId, "efs", false, "Exact EFS ID persisted from this project's Terraform outputs."));
      const accessPoints = await this.tryJson(["efs", "describe-access-points", "--file-system-id", efsId, "--output", "json"], warnings, "Mapped EFS access points", true);
      for (const point of accessPoints.AccessPoints || []) { const pointId = String(point.AccessPointId || ""); if (pointId) this.add(resources, this.mappedResource(String(point.AccessPointArn || pointId), pointId, "efs_access_point", false, "EFS access point belongs to the mapped project file system.")); }
      const targets = await this.tryJson(["efs", "describe-mount-targets", "--file-system-id", efsId, "--output", "json"], warnings, "Mapped EFS mount targets", true);
      for (const target of targets.MountTargets || []) { const targetId = String(target.MountTargetId || ""); if (targetId) this.add(resources, this.mappedResource(`efs-mount-target:${targetId}`, targetId, "efs_mount_target", false, "EFS mount target belongs to the mapped project file system.")); }
    }
    const vpcId = environment?.vpcId || this.outputString(outputs, "vpc_id");
    if (vpcId) {
      const value = await this.tryJson(["ec2", "describe-vpcs", "--vpc-ids", vpcId, "--output", "json"], warnings, "Mapped VPC", true);
      if (value.Vpcs?.length) this.add(resources, this.mappedResource(vpcId, vpcId, "vpc", false, "Exact VPC ID persisted for this project's infrastructure environment."));
    }

    const stateKey = this.terraformState.buildStateKey({ id: projectId }, environment?.environmentName || "dev");
    const lockfileKey = this.terraformState.buildLockfileKey({ id: projectId }, environment?.environmentName || "dev");
    const bucket = this.config.get<string>("TERRAFORM_STATE_BUCKET", "deployguard-state-bucket");
    if (bucket === "deployguard-state-bucket") {
      const stateHead = await this.tryJson(["s3api", "head-object", "--bucket", bucket, "--key", stateKey, "--output", "json"], warnings, "Terraform state object", true);
      if (Object.keys(stateHead).length) this.add(resources, { id: `s3://${bucket}/${stateKey}`, arn: null, name: stateKey, category: "terraform_state", source: "state_backend", projectScoped: true, protected: true, cleanupSupported: false, risk: "high", costRisk: "none", deleteStatus: "protected", reason: "Project state is retained for audit and recovery; the shared bucket is never deleted." });
      try {
        const lock = await this.terraformState.inspectNativeLockfile({ id: projectId }, environment?.environmentName || "dev");
        if (lock.exists) this.add(resources, { id: `s3://${bucket}/${lockfileKey}`, arn: null, name: lockfileKey, category: "terraform_lockfile", source: "state_backend", projectScoped: true, protected: !lock.stale, cleanupSupported: lock.stale, risk: "high", costRisk: "none", deleteStatus: lock.stale ? "found" : "protected", reason: lock.stale ? "Confirmed stale S3 native lockfile." : "Active lockfiles are protected.", metadata: { stale: lock.stale, lastModified: lock.lastModified } });
      } catch (error) { warnings.push(this.safeError("Terraform lockfile discovery", error)); }
    } else {
      warnings.push("Configured Terraform state bucket is not the protected DeployGuard state bucket; cleanup is disabled.");
    }
    const backupOperations = await this.destroyOperations.find({ where: { projectId }, order: { createdAt: "DESC" }, take: 100 });
    for (const operation of backupOperations) { if (!operation.stateBackupReference || operation.stateBackupReference.startsWith("demo:")) continue; this.add(resources, { id: `s3-version:${projectId}:${operation.stateBackupReference}`, arn: null, name: `${stateKey} version ${operation.stateBackupReference}`, category: "terraform_state_backup", source: "state_backend", projectScoped: true, protected: true, cleanupSupported: false, risk: "high", costRisk: "none", deleteStatus: "protected", reason: "Versioned Terraform state backup is retained for recovery and audit.", metadata: { stateKey, versionId: operation.stateBackupReference, destroyOperationId: operation.id } }); }

    const list = [...resources.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    const remaining = list.filter((resource) => !resource.protected && resource.category !== "terraform_state");
    const terraformResourceTypes = new Set([
      "vpc", "subnet", "route_table", "internet_gateway", "nat_gateway", "elastic_ip",
      "security_group", "load_balancer", "listener", "target_group", "ecs_cluster",
      "ecs_service", "cloud_map_namespace", "cloud_map_service", "efs", "efs_access_point",
      "efs_mount_target", "event_rule",
    ]);
    const hasTerraformStateProof = Boolean(
      environment?.terraformStateKey || Object.keys(environment?.terraformOutputs || {}).length,
    );
    const usesTerraformDestroy = (resource: ProjectCloudResource) =>
      !resource.protected &&
      (resource.source === "deployment_mapping" ||
        (hasTerraformStateProof && resource.projectScoped && terraformResourceTypes.has(resource.category)));
    const summary = {
      total: list.length,
      remaining: remaining.length,
      cleanupSupported: remaining.filter((resource) => resource.cleanupSupported).length,
      needsManualReview: remaining.filter((resource) => !resource.cleanupSupported && !usesTerraformDestroy(resource)).length,
      protected: list.filter((resource) => resource.protected).length,
      costRisk: remaining.some((resource) => resource.costRisk === "high") ? "high" : remaining.some((resource) => resource.costRisk === "medium") ? "medium" : remaining.length ? "low" : "none",
      verified: warnings.length === 0,
      status: warnings.length ? "inventory_incomplete" : remaining.length ? "cleanup_required" : "no_project_resources_found",
    };
    for (const resource of list) {
      const terraformManaged = usesTerraformDestroy(resource);
      await this.registry.register({ projectId, resourceType: resource.category, awsService: resource.awsService || this.service(resource.category), region: resource.region || environment?.awsRegion || this.config.get<string>("AWS_REGION", "us-east-1"), resourceId: resource.id, arn: resource.arn, name: resource.name, source: terraformManaged ? "terraform" : resource.source === "tags" ? "discovered_tag" : "state_backend", ownership: resource.protected && resource.category.startsWith("terraform_state") ? "project_owned" : resource.protected ? "shared" : "project_owned", cleanupEligibility: resource.protected ? "protected" : terraformManaged ? "terraform_destroy" : resource.cleanupSupported ? "safe_cleanup" : "manual_review", costRisk: resource.costRisk, tags: resource.protected ? undefined : { ManagedBy: "DeployGuard", ProjectId: projectId, Environment: environment?.environmentName || "dev" }, metadata: resource.metadata, status: resource.protected ? "protected" : "active", reason: terraformManaged ? "Terraform-managed resource. Run project-scoped Terraform destroy. Direct deletion is disabled to avoid dependency issues." : resource.reason });
    }
    await this.scans.save(this.scans.create({ scope: "project", projectId, region: environment?.awsRegion || this.config.get<string>("AWS_REGION", "us-east-1"), status: warnings.length ? "completed_with_errors" : "completed", resourceCount: list.length, servicesChecked: ["tagging", "ecr", "secrets_manager", "cloudwatch_logs", "ecs", "elbv2", "efs", "ec2", "iam", "s3_state"], errors: warnings, startedAt, completedAt: new Date() }));
    for (const warning of warnings) await this.audit.record({ actorUser, action: "CLOUD_INVENTORY_SERVICE_SCAN_FAILED", resourceType: "project", resourceId: projectId, status: "failed", metadata: { projectId, operationId: operationId || null, reason: warning } });
    await this.audit.record({ actorUser, action: "PROJECT_CLOUD_INVENTORY_COMPLETED", resourceType: "project", resourceId: projectId, status: warnings.length ? "warning" : "success", metadata: { projectId, operationId: operationId || null, resourceCount: list.length, remainingCount: remaining.length, warningCount: warnings.length } });
    const intentionalCleanupOperation = operationId
      ? backupOperations.find((operation) => operation.id === operationId)
      : null;
    if (this.shouldReportResidue(remaining.length, operationId, backupOperations) && intentionalCleanupOperation) {
      await this.audit.record({
        actorUser,
        action: "PROJECT_CLOUD_RESIDUE_FOUND",
        resourceType: "project",
        resourceId: projectId,
        status: "warning",
        metadata: {
          projectId,
          operationId: intentionalCleanupOperation.id,
          categories: [...new Set(remaining.map((resource) => resource.category))],
          resourceCount: remaining.length,
        },
      });
    }
    return { project: { id: project.id, name: project.name, repositoryFullName: project.repositoryFullName }, lastDeployment: latestRun ? { runId: latestRun.id, status: latestRun.status, createdAt: latestRun.createdAt } : null, environment: environment ? { id: environment.id, name: environment.environmentName, status: environment.status, region: environment.awsRegion } : null, state: { bucket, stateKey, lockfileKey, bucketProtected: true }, resources: list, summary, warnings, scannedAt: new Date() };
  }

  async cleanup(projectId: string, selectedIds: string[] | undefined, actorUser: User, operationId?: string | null) {
    const inventory = await this.scan(projectId, actorUser, operationId);
    const selected = selectedIds?.length ? new Set(selectedIds) : null;
    const targets = inventory.resources.filter((resource) => resource.projectScoped && !resource.protected && resource.cleanupSupported && (!selected || selected.has(resource.id)));
    const results: Array<{ id: string; category: string; status: "deleted" | "failed"; message: string }> = [];
    for (const resource of targets) {
      try {
        await this.deleteResource(projectId, resource);
        results.push({ id: resource.id, category: resource.category, status: "deleted", message: "Project-scoped resource cleanup requested." });
        await this.audit.record({ actorUser, action: "PROJECT_CLOUD_RESOURCE_DELETED", resourceType: "cloud_resource", resourceId: resource.id, status: "success", metadata: { projectId, operationId: operationId || null, category: resource.category } });
      } catch (error) {
        const message = this.safeError("Cleanup", error);
        results.push({ id: resource.id, category: resource.category, status: "failed", message });
        await this.audit.record({ actorUser, action: "PROJECT_CLOUD_RESOURCE_CLEANUP_FAILED", resourceType: "cloud_resource", resourceId: resource.id, status: "failed", metadata: { projectId, operationId: operationId || null, category: resource.category, reason: message } });
      }
    }
    const refreshed = await this.scan(projectId, actorUser, operationId);
    return { results, inventory: refreshed };
  }

  private async deleteResource(projectId: string, resource: ProjectCloudResource) {
    if (!resource.projectScoped || resource.protected) throw new Error("Resource is not eligible for project cleanup.");
    if (resource.category === "ecr_repository") {
      if (!this.safeRepositoryName(resource.name)) throw new Error("Unsafe ECR repository name.");
      await this.aws.run(["ecr", "delete-repository", "--repository-name", resource.name, "--force"]); return;
    }
    if (resource.category === "secret") {
      if (!resource.name.startsWith(`deployguard/${projectId}/`)) throw new Error("Secret is outside the project prefix.");
      const force = this.config.get<string>("SECRETS_FORCE_DELETE_WITHOUT_RECOVERY", "false").toLowerCase() === "true";
      await this.aws.run(["secretsmanager", "delete-secret", "--secret-id", resource.arn || resource.name, ...(force ? ["--force-delete-without-recovery"] : ["--recovery-window-in-days", "7"])]); return;
    }
    if (resource.category === "log_group") {
      if (!resource.name.startsWith(`/deployguard/${projectId}/`)) throw new Error("Log group is outside the project prefix.");
      await this.aws.run(["logs", "delete-log-group", "--log-group-name", resource.name]); return;
    }
    if (resource.category === "ecs_task_definition") {
      const prefix = `dg-${projectId.replace(/-/g, "").slice(0, 20)}-`;
      if (!this.taskFamily(resource.arn || resource.id).startsWith(prefix)) throw new Error("Task definition is outside the project family prefix.");
      await this.aws.run(["ecs", "deregister-task-definition", "--task-definition", resource.arn || resource.id]); return;
    }
    if (resource.category === "terraform_lockfile") {
      const environment = String(resource.metadata?.environment || "dev");
      const lock = await this.terraformState.inspectNativeLockfile({ id: projectId }, environment);
      if (!lock.exists || !lock.stale || lock.key !== resource.name) throw new Error("Only a confirmed stale project lockfile can be removed.");
      await this.terraformState.clearStaleNativeLockfile({ id: projectId }, environment); return;
    }
    throw new Error("This resource category requires Terraform destroy or manual review.");
  }

  private resourceFromArn(arn: string, source: "tags", projectScoped: boolean): ProjectCloudResource {
    const category = this.category(arn);
    const name = arn.split(/[/:]/).filter(Boolean).pop() || arn;
    const cleanupSupported = ["secret", "log_group", "ecs_task_definition"].includes(category);
    return { id: arn, arn, name, category, source, projectScoped, protected: false, cleanupSupported, risk: this.risk(category), costRisk: this.costRisk(category), deleteStatus: "found", reason: "Exact DeployGuard project tags matched." };
  }
  private mappedResource(arn: string, name: string, category: string, cleanupSupported: boolean, reason: string): ProjectCloudResource { return { id: arn, arn, name, category, source: "deployment_mapping", projectScoped: true, protected: false, cleanupSupported, risk: this.risk(category), costRisk: this.costRisk(category), deleteStatus: "found", reason }; }
  private add(map: Map<string, ProjectCloudResource>, resource: ProjectCloudResource) { const duplicate = [...map.values()].find((current) => current.id === resource.id || (current.category === resource.category && (current.arn === resource.arn || current.name === resource.name))); if (!duplicate) { map.set(resource.id, resource); return; } if (resource.source === "deployment_mapping" || (!duplicate.cleanupSupported && resource.cleanupSupported)) { map.delete(duplicate.id); map.set(resource.id, resource); } }
  private category(arn: string) { if (arn.includes(":ecr:")) return "ecr_repository"; if (arn.includes(":secretsmanager:")) return "secret"; if (arn.includes(":logs:")) return "log_group"; if (arn.includes(":ecs:") && arn.includes("task-definition/")) return "ecs_task_definition"; if (arn.includes(":ecs:") && arn.includes("task/")) return "ecs_task"; if (arn.includes(":ecs:") && arn.includes("service/")) return "ecs_service"; if (arn.includes(":ecs:") && arn.includes("cluster/")) return "ecs_cluster"; if (arn.includes(":elasticloadbalancing:") && arn.includes("listener/")) return "listener"; if (arn.includes(":elasticloadbalancing:") && arn.includes("loadbalancer/")) return "load_balancer"; if (arn.includes(":elasticloadbalancing:") && arn.includes("targetgroup/")) return "target_group"; if (arn.includes(":elasticfilesystem:") && arn.includes("access-point/")) return "efs_access_point"; if (arn.includes(":elasticfilesystem:")) return "efs"; if (arn.includes(":servicediscovery:") && arn.includes(":namespace/")) return "cloud_map_namespace"; if (arn.includes(":servicediscovery:") && arn.includes(":service/")) return "cloud_map_service"; if (arn.includes(":events:") && arn.includes(":rule/")) return "event_rule"; if (arn.includes(":ec2:") && arn.includes("natgateway/")) return "nat_gateway"; if (arn.includes(":ec2:") && arn.includes("elastic-ip/")) return "elastic_ip"; if (arn.includes(":ec2:") && arn.includes("subnet/")) return "subnet"; if (arn.includes(":ec2:") && arn.includes("route-table/")) return "route_table"; if (arn.includes(":ec2:") && arn.includes("internet-gateway/")) return "internet_gateway"; if (arn.includes(":ec2:") && arn.includes("security-group/")) return "security_group"; if (arn.includes(":ec2:") && arn.includes("vpc/")) return "vpc"; if (arn.includes(":iam:") && arn.includes(":role/")) return "iam_role"; if (arn.includes(":iam:") && arn.includes(":policy/")) return "iam_policy"; if (arn.includes(":kms:")) return "kms_key"; if (arn.includes(":backup:")) return "backup"; return "other"; }
  private risk(category: string): "low" | "medium" | "high" { return ["log_group", "ecs_task_definition"].includes(category) ? "low" : ["ecr_repository", "secret"].includes(category) ? "medium" : "high"; }
  private costRisk(category: string): "none" | "low" | "medium" | "high" { if (["nat_gateway", "load_balancer", "ecs_service"].includes(category)) return "high"; if (["ecr_repository", "efs", "log_group", "backup"].includes(category)) return "medium"; if (["terraform_state", "terraform_lockfile", "ecs_task_definition", "iam", "kms"].includes(category)) return "none"; return "low"; }
  private service(category: string) { if (["ecr_repository", "ecr_image"].includes(category)) return "ecr"; if (["ecs_cluster", "ecs_service", "ecs_task", "ecs_task_definition"].includes(category)) return "ecs"; if (["load_balancer", "target_group", "listener"].includes(category)) return "elasticloadbalancing"; if (["efs", "efs_access_point", "efs_mount_target"].includes(category)) return "elasticfilesystem"; if (["log_group", "log_stream"].includes(category)) return "logs"; if (category === "secret") return "secretsmanager"; if (category.startsWith("terraform_")) return "s3"; if (category.startsWith("iam")) return "iam"; if (category.startsWith("backup")) return "backup"; if (category.startsWith("cloud_map")) return "servicediscovery"; return "ec2"; }
  private safeRepositoryName(value: string) { return /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(value) && value.length <= 256; }
  private shouldReportResidue(remainingCount: number, operationId: string | null | undefined, operations: DestroyOperation[]) {
    return remainingCount > 0 && Boolean(operationId && operations.some((operation) => operation.id === operationId));
  }
  private taskFamily(arn: string) { return arn.split("task-definition/")[1]?.split(":")[0] || arn; }
  private arnName(value: string) { return value.split(/[/:]/).filter(Boolean).pop() || value; }
  private outputString(outputs: Record<string, unknown>, key: string) { const value = outputs[key]; return typeof value === "string" && value.trim() ? value.trim() : null; }
  private async tryJson(args: string[], warnings: string[], label: string, ignoreMissing = false): Promise<Record<string, any>> { try { const result = await this.aws.run(args); return JSON.parse(result.stdout || "{}"); } catch (error) { const message = error instanceof Error ? error.message : String(error); if (!ignoreMissing || !/not found|notfound|does not exist/i.test(message)) warnings.push(this.safeError(label, error)); return {}; } }
  private safeError(label: string, error: unknown) { const value = error instanceof Error ? error.message : String(error); return `${label}: ${this.aws.sanitize(value).slice(0, 500)}`; }
}
