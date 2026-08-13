import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { ProjectInfrastructureEnvironment } from "../infrastructure/project-infrastructure-environment.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { Project } from "../projects/project.entity";
import { AwsCliService } from "../state-management/aws-cli.service";
import { User } from "../users/user.entity";
import { TerraformStateService } from "../state-management/terraform-state.service";
import { CentralCloudResource } from "./central-cloud-resource.entity";
import { CloudResourceClassifierService, DiscoveredCloudResource, KnownProject } from "./cloud-resource-classifier.service";
import { CentralCloudResourceQueryDto } from "./dto/central-cloud-cleanup.dto";
import { DestroyOperation } from "./destroy-operation.entity";
import { CloudInventoryScan } from "./cloud-inventory-scan.entity";
import { EmergencyCleanupOperation } from "./emergency-cleanup-operation.entity";
import { CloudCleanupOperation } from "./cloud-cleanup-operation.entity";
import { CloudStateReconciliationService } from "./cloud-state-reconciliation.service";
import { ProjectCloudState } from "./project-cloud-state.entity";

type Tag = { Key?: string; Value?: string };

@Injectable()
export class CentralCloudInventoryService {
  constructor(
    @InjectRepository(CentralCloudResource) private readonly records: Repository<CentralCloudResource>,
    @InjectRepository(Project) private readonly projects: Repository<Project>,
    @InjectRepository(ProjectPipelineRun) private readonly runs: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectInfrastructureEnvironment) private readonly environments: Repository<ProjectInfrastructureEnvironment>,
    @InjectRepository(DestroyOperation) private readonly destroyOperations: Repository<DestroyOperation>,
    @InjectRepository(CloudInventoryScan) private readonly scans: Repository<CloudInventoryScan>,
    @InjectRepository(EmergencyCleanupOperation) private readonly emergencyOperations: Repository<EmergencyCleanupOperation>,
    @InjectRepository(CloudCleanupOperation) private readonly cleanupOperationRecords: Repository<CloudCleanupOperation>,
    @InjectRepository(ProjectCloudState) private readonly projectCloudStates: Repository<ProjectCloudState>,
    private readonly classifier: CloudResourceClassifierService,
    private readonly aws: AwsCliService,
    private readonly terraformState: TerraformStateService,
    private readonly config: ConfigService,
    private readonly audit: AuditLogService,
    private readonly cloudState: CloudStateReconciliationService,
  ) {}

  async refresh(actorUser: User, req?: any) {
    const startedAt = new Date();
    await this.audit.record({ actorUser, action: "CENTRAL_CLOUD_INVENTORY_REFRESH_STARTED", resourceType: "cloud_inventory", status: "success", metadata: { region: this.region }, req });
    const [projects, environments, runs] = await Promise.all([
      this.projects.find(),
      this.environments.find({ order: { updatedAt: "DESC" } }),
      this.runs.find({ select: { projectId: true, ecrRepositoryName: true } as any }),
    ]);
    const latestEnvironment = new Map<string, ProjectInfrastructureEnvironment>();
    for (const environment of environments) if (!latestEnvironment.has(environment.projectId)) latestEnvironment.set(environment.projectId, environment);
    const knownProjects = new Map<string, KnownProject>(projects.map((project) => [project.id, { id: project.id, name: project.name, infrastructureStatus: latestEnvironment.get(project.id)?.status }]));
    const ecrOwners = new Map<string, Set<string>>();
    for (const run of runs) if (run.ecrRepositoryName) { const owners = ecrOwners.get(run.ecrRepositoryName) || new Set<string>(); owners.add(run.projectId); ecrOwners.set(run.ecrRepositoryName, owners); }

    const warnings: string[] = [];
    const discovered = new Map<string, DiscoveredCloudResource>();
    await this.discoverTagged(discovered, warnings);
    this.discoverTerraformMappings(discovered, environments);
    await Promise.all([
      this.discoverEcr(discovered, ecrOwners, warnings),
      this.discoverLogs(discovered, warnings),
      this.discoverSecrets(discovered, warnings),
      this.discoverEcs(discovered, knownProjects, warnings),
      this.discoverElb(discovered, warnings),
      this.discoverEc2(discovered, warnings),
      this.discoverEfs(discovered, warnings),
      this.discoverIam(discovered, warnings),
      this.discoverState(discovered, warnings),
    ]);
    this.discoverStateBackups(discovered, await this.destroyOperations.find());

    const current = await this.records.find();
    const currentByKey = new Map(current.map((record) => [record.resourceKey, record]));
    const seen = new Set<string>();
    for (const resource of discovered.values()) {
      const classified = this.classifier.classify(resource, knownProjects);
      const existing = currentByKey.get(classified.resourceKey);
      const record = existing || this.records.create({ resourceKey: classified.resourceKey, firstSeenAt: startedAt });
      Object.assign(record, {
        arn: classified.arn || null,
        resourceName: classified.name,
        resourceType: classified.resourceType,
        awsService: classified.awsService,
        region: classified.region,
        projectId: classified.projectId,
        pipelineRunId: existing?.pipelineRunId || null,
        source: classified.source,
        ownership: classified.metadata?.shared === true ? "shared" : classified.projectId ? "project_owned" : classified.status === "orphan" ? "orphan" : classified.protected ? "shared" : "unknown",
        cleanupEligibility: classified.protected ? "protected" : classified.safeToCleanup ? "safe_cleanup" : classified.source === "terraform" ? "terraform_destroy" : "manual_review",
        status: classified.status,
        costRisk: classified.costRisk,
        safeToCleanup: classified.safeToCleanup,
        cleanupSupported: classified.cleanupSupported,
        protected: classified.protected,
        reason: classified.reason,
        metadata: this.safeMetadata({ ...(classified.metadata || {}), projectName: classified.projectName }),
        tags: classified.tags || existing?.tags || null,
        lastSeenAt: startedAt,
        deletedAt: null,
      });
      await this.records.save(record);
      seen.add(record.resourceKey);
      await this.audit.record({ actorUser, action: "CENTRAL_CLOUD_RESOURCE_DISCOVERED", resourceType: "cloud_resource", resourceId: record.id, status: "success", metadata: { projectId: record.projectId, resourceType: record.resourceType, source: record.source } });
      await this.audit.record({ actorUser, action: "CENTRAL_CLOUD_RESOURCE_CLASSIFIED", resourceType: "cloud_resource", resourceId: record.id, status: classified.status === "manual_review" ? "warning" : "success", metadata: { projectId: record.projectId, resourceType: record.resourceType, source: record.source, classification: record.status } });
      if (record.protected) await this.audit.record({ actorUser, action: "CENTRAL_CLOUD_PROTECTED_RESOURCE_SKIPPED", resourceType: "cloud_resource", resourceId: record.id, status: "success", metadata: { projectId: record.projectId, resourceType: record.resourceType } });
      if (record.status === "manual_review") await this.audit.record({ actorUser, action: "CENTRAL_CLOUD_MANUAL_REVIEW_REQUIRED", resourceType: "cloud_resource", resourceId: record.id, status: "warning", metadata: { projectId: record.projectId, resourceType: record.resourceType, reason: record.reason } });
    }
    if (!warnings.length) {
      for (const record of current) {
        if (!seen.has(record.resourceKey) && !record.protected) {
          record.status = "deleted";
          record.deletedAt = record.deletedAt || startedAt;
          record.safeToCleanup = false;
          await this.records.save(record);
        }
      }
    }
    await this.updateProjectStatuses(projects, latestEnvironment);
    for (const warning of warnings) await this.audit.record({ actorUser, action: "CLOUD_INVENTORY_SERVICE_SCAN_FAILED", resourceType: "cloud_inventory", status: "failed", metadata: { region: this.region, reason: warning }, req });
    await this.scans.save(this.scans.create({ scope: "account", projectId: null, region: this.region, status: warnings.length ? "completed_with_errors" : "completed", resourceCount: discovered.size, servicesChecked: ["tagging", "ecr", "cloudwatch_logs", "secrets_manager", "ecs", "elbv2", "ec2", "efs", "iam", "s3_state"], errors: warnings, startedAt, completedAt: new Date() }));
    await Promise.allSettled(projects.map((project) => this.cloudState.reconcile(project.id)));
    const summary = await this.summary();
    await this.audit.record({ actorUser, action: "CENTRAL_CLOUD_INVENTORY_REFRESH_COMPLETED", resourceType: "cloud_inventory", status: warnings.length ? "warning" : "success", metadata: { region: this.region, resourceCount: discovered.size, warningCount: warnings.length }, req });
    return { ...summary, warnings, refreshedAt: startedAt };
  }

  async summary() {
    const [resources, projects, environments, operations, emergencyOperations, cleanupOperations, latestScan, pipelineRuns, cloudStates] = await Promise.all([this.records.find(), this.projects.find(), this.environments.find({ order: { updatedAt: "DESC" } }), this.destroyOperations.find({ order: { createdAt: "DESC" } }), this.emergencyOperations.find({ order: { createdAt: "DESC" }, take: 25 }), this.cleanupOperationRecords.find({ order: { createdAt: "DESC" }, take: 25 }), this.scans.findOne({ where: { scope: "account" }, order: { completedAt: "DESC" } }), this.runs.find({ order: { createdAt: "DESC" } }), this.projectCloudStates.find()]);
    await this.reconcileTerraformProof(resources, environments);
    const live = resources.filter((resource) => resource.status !== "deleted");
    const latest = new Map<string, ProjectInfrastructureEnvironment>();
    for (const environment of environments) if (!latest.has(environment.projectId)) latest.set(environment.projectId, environment);
    const latestDestroy = new Map<string, DestroyOperation>();
    for (const operation of operations) if (!latestDestroy.has(operation.projectId)) latestDestroy.set(operation.projectId, operation);
    const latestRun = new Map<string, ProjectPipelineRun>();
    for (const run of pipelineRuns) if (!latestRun.has(run.projectId)) latestRun.set(run.projectId, run);
    const verifiedState = new Map(cloudStates.map((state) => [state.projectId, state]));
    return {
      summary: {
        totalResourcesDiscovered: resources.length,
        activeProjects: new Set(live.filter((resource) => resource.status === "active" && resource.projectId).map((resource) => resource.projectId)).size,
        activeProjectResources: live.filter((resource) => resource.status === "active").length,
        orphanResources: live.filter((resource) => resource.status === "orphan").length,
        cleanupRequiredProjects: new Set(live.filter((resource) => resource.status === "cleanup_required").map((resource) => resource.projectId).filter(Boolean)).size,
        highCostRiskResources: live.filter((resource) => resource.costRisk === "high" && !resource.protected).length,
        protectedSharedResources: live.filter((resource) => resource.protected).length,
        safeCleanupResources: live.filter((resource) => resource.safeToCleanup).length,
        manualReviewResources: live.filter((resource) => resource.cleanupEligibility === "manual_review" || resource.status === "manual_review").length,
        safeOrphanResources: live.filter((resource) => resource.status === "orphan" && resource.safeToCleanup).length,
        lastRefreshedAt: live.sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())[0]?.lastSeenAt || null,
        region: this.region,
        inventoryErrors: latestScan?.errors?.length || 0,
        scanStatus: latestScan?.status || "not_scanned",
      },
      latestScan: latestScan ? { id: latestScan.id, status: latestScan.status, servicesChecked: latestScan.servicesChecked, errors: latestScan.errors, resourceCount: latestScan.resourceCount, startedAt: latestScan.startedAt, completedAt: latestScan.completedAt } : null,
      cleanupOperations: [
        ...operations.slice(0, 25).map((operation) => ({ id: operation.id, kind: "project_destroy", projectId: operation.projectId, status: operation.status, cleanupStatus: operation.cleanupStatus, createdAt: operation.createdAt, completedAt: operation.completedAt })),
        ...emergencyOperations.map((operation) => ({ id: operation.id, kind: "emergency", projectId: null, status: operation.status, cleanupStatus: operation.status, targetCount: operation.targetCount, completedCount: operation.completedCount, failedCount: operation.failedCount, createdAt: operation.createdAt, completedAt: operation.completedAt })),
        ...cleanupOperations.map((operation) => ({ id: operation.id, kind: `direct_${operation.mode}`, projectId: null, status: operation.status, cleanupStatus: operation.status, createdAt: operation.createdAt, completedAt: operation.completedAt })),
      ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 25),
      projects: projects.map((project) => {
        const environment = latest.get(project.id);
        const projectResources = live.filter((resource) => resource.projectId === project.id && !resource.protected);
        const manual = projectResources.filter((resource) => resource.status === "manual_review" || !resource.safeToCleanup && resource.status !== "active").length;
        const resourceStatus = String(environment?.metadata?.cloudResourceStatus || (projectResources.length ? "live" : "no_cloud_resources_found"));
        const destroy = latestDestroy.get(project.id);
        const run = latestRun.get(project.id);
        const state = verifiedState.get(project.id);
        return { id: project.id, name: project.name, repositoryFullName: project.repositoryFullName, deploymentStatus: state?.lastVerifiedDeploymentStatus || "unknown", healthStatus: state?.lastVerifiedHealthStatus || "unknown", infrastructureStatus: state?.lastVerifiedInfrastructureStatus || environment?.status || "not_provisioned", resourceStatus: state?.lastVerifiedResourceStatus || resourceStatus, cleanupStatus: state?.lastVerifiedCleanupStatus || "not_requested", cloudVerificationStatus: state?.cloudVerificationStatus || "verification_required", inventoryStatus: state?.inventoryStatus || (latestScan ? "scanned" : "not_scanned"), nextAction: state?.nextAction || "refresh_inventory", statusExplanation: state?.lastVerificationReason || "Cloud state has not been reconciled for this project.", resourceCount: projectResources.length, highCostCount: projectResources.filter((resource) => resource.costRisk === "high").length, manualReviewCount: manual, canMarkCleanupComplete: Boolean(environment && latestScan && latestScan.errors.length === 0 && projectResources.length === 0 && ["destroyed", "destroy_needs_cleanup", "destroy_failed"].includes(environment.status)), lastDeployment: run ? { id: run.id, status: run.status, createdAt: run.createdAt } : null, latestDestroy: destroy ? { id: destroy.id, status: destroy.status, environmentName: destroy.environmentName, cleanupStatus: destroy.cleanupStatus } : null };
      }),
    };
  }

  async resources(query: CentralCloudResourceQueryDto = {}) {
    await this.reconcileTerraformProof(await this.records.find(), await this.environments.find({ order: { updatedAt: "DESC" } }));
    const builder = this.records.createQueryBuilder("resource").orderBy("resource.lastSeenAt", "DESC");
    if (query.projectId) builder.andWhere("resource.projectId = :projectId", { projectId: query.projectId });
    if (query.resourceType) builder.andWhere("resource.resourceType = :resourceType", { resourceType: query.resourceType });
    if (query.status) builder.andWhere("resource.status = :status", { status: query.status });
    if (query.risk) builder.andWhere("resource.costRisk = :risk", { risk: query.risk });
    if (query.region) builder.andWhere("resource.region = :region", { region: query.region });
    if (query.eligibility === "safe") builder.andWhere("resource.safeToCleanup = true");
    if (query.eligibility === "manual") builder.andWhere("resource.status = 'manual_review'");
    if (query.eligibility === "protected") builder.andWhere("resource.protected = true");
    const resources = await builder.getMany();
    const safe = resources.map((resource) => this.safeResource(resource));
    return { resources: safe, groups: this.groupResources(safe), count: resources.length };
  }

  async reconcileProjectTerraformProof(projectId: string) {
    const [resources, environments] = await Promise.all([this.records.find({ where: { projectId } }), this.environments.find({ where: { projectId }, order: { updatedAt: "DESC" } })]);
    await this.reconcileTerraformProof(resources, environments);
  }

  async markManualReview(resourceIds: string[], actorUser: User, req?: any) {
    const resources = await this.records.findByIds(resourceIds);
    for (const resource of resources) {
      if (resource.protected || resource.status === "deleted") continue;
      resource.status = "manual_review";
      resource.safeToCleanup = false;
      resource.manualReviewAt = new Date();
      resource.reason = "An administrator marked this resource for manual review.";
      await this.records.save(resource);
      await this.audit.record({ actorUser, action: "CENTRAL_CLOUD_MANUAL_REVIEW_REQUIRED", resourceType: "cloud_resource", resourceId: resource.id, status: "warning", metadata: { projectId: resource.projectId, resourceType: resource.resourceType }, req });
    }
    return this.resources();
  }

  async markProjectCleanupComplete(projectId: string, actorUser: User, req?: any) {
    const [project, environment, latestScan, resources] = await Promise.all([
      this.projects.findOne({ where: { id: projectId } }),
      this.environments.findOne({ where: { projectId }, order: { updatedAt: "DESC" } }),
      this.scans.findOne({ where: { scope: "account" }, order: { completedAt: "DESC" } }),
      this.records.find({ where: { projectId } }),
    ]);
    if (!project || !environment) throw new NotFoundException("Project infrastructure was not found.");
    const live = resources.filter((resource) => resource.status !== "deleted" && !resource.protected);
    if (!latestScan || latestScan.errors.length || live.length) throw new ConflictException("Cleanup can only be marked complete after a successful inventory scan finds no remaining project resources.");
    environment.status = "destroyed";
    environment.errorMessage = null;
    environment.metadata = { ...(environment.metadata || {}), cloudResourceStatus: "no_cloud_resources_found", cleanupVerifiedAt: new Date().toISOString(), cleanupVerifiedBy: actorUser.id };
    await this.environments.save(environment);
    await this.audit.record({ actorUser, action: "PROJECT_CLOUD_CLEANUP_MARKED_COMPLETED", resourceType: "project", resourceId: projectId, status: "success", metadata: { projectId, inventoryScanId: latestScan.id }, req });
    return this.summary();
  }

  private async discoverTagged(resources: Map<string, DiscoveredCloudResource>, warnings: string[]) {
    const payload = await this.tryJson(["resourcegroupstaggingapi", "get-resources", "--tag-filters", "Key=ManagedBy,Values=DeployGuard", "--output", "json"], warnings, "DeployGuard tag discovery");
    for (const mapping of payload.ResourceTagMappingList || []) {
      const arn = String(mapping.ResourceARN || ""); if (!arn) continue;
      this.add(resources, { resourceKey: arn, arn, name: this.nameFromArn(arn), resourceType: this.typeFromArn(arn), awsService: this.serviceFromArn(arn), region: this.regionFromArn(arn), tags: this.tags(mapping.Tags), source: "discovered_tag" });
    }
  }

  private discoverTerraformMappings(resources: Map<string, DiscoveredCloudResource>, environments: ProjectInfrastructureEnvironment[]) {
    for (const environment of environments) {
      if (["destroyed", "destroy_needs_cleanup"].includes(environment.status)) continue;
      const outputs = environment.terraformOutputs || {};
      const arnMappings: Array<[string, string, string]> = [
        ["alb_arn", "load_balancer", "elasticloadbalancing"], ["alb_target_group_arn", "target_group", "elasticloadbalancing"], ["alb_listener_arn", "listener", "elasticloadbalancing"],
        ["ecs_cluster_arn", "ecs_cluster", "ecs"], ["ecs_service_arn", "ecs_service", "ecs"], ["ecs_task_definition_arn", "ecs_task_definition", "ecs"], ["efs_file_system_arn", "efs", "elasticfilesystem"],
        ["efs_kms_key_arn", "kms_key", "kms"], ["efs_access_point_arn", "efs_access_point", "elasticfilesystem"], ["spot_event_rule_arn", "event_rule", "events"],
      ];
      for (const [key, resourceType, awsService] of arnMappings) { const arn = typeof outputs[key] === "string" ? String(outputs[key]) : ""; if (arn) this.add(resources, { resourceKey: arn, arn, name: this.arnName(arn), resourceType, awsService, region: environment.awsRegion || this.region, source: "terraform", projectId: environment.projectId }); }
      const idMappings: Array<[unknown, string, string]> = [
        [environment.vpcId || outputs.vpc_id, "vpc", "ec2"], [environment.internetGatewayId || outputs.internet_gateway_id, "internet_gateway", "ec2"],
        [environment.albSecurityGroupId || outputs.alb_security_group_id, "security_group", "ec2"], [environment.appSecurityGroupId || outputs.app_security_group_id, "security_group", "ec2"],
        [environment.internalSecurityGroupId || outputs.internal_security_group_id, "security_group", "ec2"], [outputs.efs_file_system_id, "efs", "elasticfilesystem"],
        [outputs.efs_access_point_id, "efs_access_point", "elasticfilesystem"], [outputs.efs_security_group_id, "security_group", "ec2"], [outputs.efs_backup_vault_name, "backup_vault", "backup"], [outputs.efs_backup_plan_id, "backup_plan", "backup"],
        [outputs.cloud_map_namespace_id, "cloud_map_namespace", "servicediscovery"], [outputs.default_cloud_map_service_id, "cloud_map_service", "servicediscovery"], [outputs.ecs_log_group_name, "log_group", "logs"], [outputs.spot_event_log_group_name, "log_group", "logs"],
      ];
      for (const [value, resourceType, awsService] of idMappings) { const id = typeof value === "string" ? value : ""; if (id) this.add(resources, { resourceKey: `${resourceType}:${id}`, arn: null, name: id, resourceType, awsService, region: environment.awsRegion || this.region, source: "terraform", projectId: environment.projectId }); }
      const collections: Array<[unknown, string, string]> = [[environment.publicSubnetIds, "subnet", "ec2"], [environment.privateSubnetIds, "subnet", "ec2"], [environment.natGatewayIds, "nat_gateway", "ec2"], [Object.values(environment.routeTableIds || {}), "route_table", "ec2"], [outputs.efs_mount_target_ids, "efs_mount_target", "elasticfilesystem"]];
      for (const [values, resourceType, awsService] of collections) for (const value of Array.isArray(values) ? values : []) { const id = String(value || ""); if (id) this.add(resources, { resourceKey: `${resourceType}:${id}`, arn: null, name: id, resourceType, awsService, region: environment.awsRegion || this.region, source: "terraform", projectId: environment.projectId }); }
    }
  }

  private async discoverEcr(resources: Map<string, DiscoveredCloudResource>, owners: Map<string, Set<string>>, warnings: string[]) {
    const payload = await this.tryJson(["ecr", "describe-repositories", "--output", "json"], warnings, "ECR discovery");
    for (const repository of payload.repositories || []) {
      const name = String(repository.repositoryName || "");
      if (!owners.has(name) && !/^(deployguard|dg|mini-paas)[-_/]/i.test(name)) continue;
      const arn = String(repository.repositoryArn || `ecr:${name}`);
      const images = await this.tryJson(["ecr", "describe-images", "--repository-name", name, "--max-items", "100", "--output", "json"], warnings, `ECR image discovery for ${name}`, true);
      const lifecycle = await this.tryJson(["ecr", "get-lifecycle-policy", "--repository-name", name, "--output", "json"], warnings, `ECR lifecycle policy for ${name}`, true);
      const mappedOwners = owners.get(name) || new Set<string>();
      const projectId = mappedOwners.size === 1 ? [...mappedOwners][0] : null;
      this.add(resources, { resourceKey: arn, arn, name, resourceType: "ecr_repository", awsService: "ecr", region: this.region, source: mappedOwners.size ? "sdk" : "naming_prefix", projectId, metadata: { itemCount: Array.isArray(images.imageDetails) ? images.imageDetails.length : 0, repositoryUri: repository.repositoryUri || null, shared: mappedOwners.size > 1, lifecyclePolicyConfigured: Boolean(lifecycle.lifecyclePolicyText) } });
      for (const image of images.imageDetails || []) { const digest = String(image.imageDigest || ""); const tags = Array.isArray(image.imageTags) ? image.imageTags.map(String) : []; if (!digest) continue; this.add(resources, { resourceKey: `${arn}@${digest}`, arn: null, name: tags[0] || digest.slice(0, 20), resourceType: "ecr_image", awsService: "ecr", region: this.region, source: mappedOwners.size ? "sdk" : "naming_prefix", projectId, metadata: { repositoryName: name, digest, tags, pushedAt: image.imagePushedAt || null, sizeBytes: image.imageSizeInBytes || null } }); }
      if (lifecycle.lifecyclePolicyText) this.add(resources, { resourceKey: `${arn}:lifecycle-policy`, arn: null, name: `${name} lifecycle policy`, resourceType: "ecr_lifecycle_policy", awsService: "ecr", region: this.region, source: mappedOwners.size ? "sdk" : "naming_prefix", projectId, metadata: { repositoryName: name } });
    }
  }

  private async discoverLogs(resources: Map<string, DiscoveredCloudResource>, warnings: string[]) {
    const payload = await this.tryJson(["logs", "describe-log-groups", "--log-group-name-prefix", "/deployguard/", "--output", "json"], warnings, "CloudWatch log discovery");
    for (const group of payload.logGroups || []) { const name = String(group.logGroupName || ""); const arn = String(group.logGroupArn || group.arn || `logs:${name}`); this.add(resources, { resourceKey: arn, arn, name, resourceType: "log_group", awsService: "logs", region: this.region, source: "naming_prefix", metadata: { storedBytes: Number(group.storedBytes || 0), retentionInDays: group.retentionInDays || null } }); const streams = await this.tryJson(["logs", "describe-log-streams", "--log-group-name", name, "--order-by", "LastEventTime", "--descending", "--max-items", "100", "--output", "json"], warnings, `CloudWatch streams for ${name}`, true); for (const stream of streams.logStreams || []) { const streamName = String(stream.logStreamName || ""); if (streamName) this.add(resources, { resourceKey: `${arn}:stream:${streamName}`, arn: String(stream.arn || "") || null, name: streamName, resourceType: "log_stream", awsService: "logs", region: this.region, source: "naming_prefix", metadata: { logGroupName: name, lastEventTimestamp: stream.lastEventTimestamp || null, storedBytes: stream.storedBytes || 0 } }); } }
  }

  private async discoverSecrets(resources: Map<string, DiscoveredCloudResource>, warnings: string[]) {
    const payload = await this.tryJson(["secretsmanager", "list-secrets", "--filters", "Key=name,Values=deployguard/", "--output", "json"], warnings, "Secrets Manager discovery");
    for (const secret of payload.SecretList || []) { const name = String(secret.Name || ""); if (!name.startsWith("deployguard/")) continue; const arn = String(secret.ARN || `secret:${name}`); this.add(resources, { resourceKey: arn, arn, name, resourceType: "secret", awsService: "secretsmanager", region: this.region, source: "naming_prefix" }); }
  }

  private async discoverEcs(resources: Map<string, DiscoveredCloudResource>, projects: Map<string, KnownProject>, warnings: string[]) {
    const definitions = await this.tryJson(["ecs", "list-task-definitions", "--status", "ACTIVE", "--output", "json"], warnings, "ECS task definition discovery");
    for (const arnValue of definitions.taskDefinitionArns || []) {
      const arn = String(arnValue); const family = arn.split("task-definition/")[1]?.split(":")[0] || arn;
      const owner = [...projects.keys()].find((id) => family.startsWith(`dg-${id.replace(/-/g, "").slice(0, 20)}-`));
      if (!owner && !/^(deployguard|dg)-/i.test(family)) continue;
      this.add(resources, { resourceKey: arn, arn, name: family, resourceType: "ecs_task_definition", awsService: "ecs", region: this.region, source: owner ? "sdk" : "naming_prefix", projectId: owner || null });
    }
    const clusters = await this.tryJson(["ecs", "list-clusters", "--output", "json"], warnings, "ECS cluster discovery");
    for (const arnValue of clusters.clusterArns || []) { const arn = String(arnValue); const name = this.arnName(arn); if (!/^(deployguard|dg)-/i.test(name)) continue; this.add(resources, { resourceKey: arn, arn, name, resourceType: "ecs_cluster", awsService: "ecs", region: this.region, source: "naming_prefix" }); const services = await this.tryJson(["ecs", "list-services", "--cluster", arn, "--output", "json"], warnings, `ECS services for ${name}`, true); for (const serviceValue of services.serviceArns || []) { const serviceArn = String(serviceValue); this.add(resources, { resourceKey: serviceArn, arn: serviceArn, name: this.arnName(serviceArn), resourceType: "ecs_service", awsService: "ecs", region: this.region, source: "naming_prefix" }); } const tasks = await this.tryJson(["ecs", "list-tasks", "--cluster", arn, "--output", "json"], warnings, `ECS tasks for ${name}`, true); for (const taskValue of tasks.taskArns || []) { const taskArn = String(taskValue); this.add(resources, { resourceKey: taskArn, arn: taskArn, name: this.arnName(taskArn), resourceType: "ecs_task", awsService: "ecs", region: this.region, source: "naming_prefix" }); } }
  }

  private async discoverElb(resources: Map<string, DiscoveredCloudResource>, warnings: string[]) {
    const lbs = await this.tryJson(["elbv2", "describe-load-balancers", "--output", "json"], warnings, "ELB discovery");
    for (const lb of lbs.LoadBalancers || []) { const name = String(lb.LoadBalancerName || ""); if (!/^(deployguard|dg)-/i.test(name)) continue; const arn = String(lb.LoadBalancerArn); this.add(resources, { resourceKey: arn, arn, name, resourceType: "load_balancer", awsService: "elasticloadbalancing", region: this.region, source: "naming_prefix", metadata: { state: lb.State?.Code || null } }); const listeners = await this.tryJson(["elbv2", "describe-listeners", "--load-balancer-arn", arn, "--output", "json"], warnings, `Listeners for ${name}`, true); for (const listener of listeners.Listeners || []) { const listenerArn = String(listener.ListenerArn); this.add(resources, { resourceKey: listenerArn, arn: listenerArn, name: this.arnName(listenerArn), resourceType: "listener", awsService: "elasticloadbalancing", region: this.region, source: "naming_prefix" }); } }
    const groups = await this.tryJson(["elbv2", "describe-target-groups", "--output", "json"], warnings, "Target group discovery");
    for (const group of groups.TargetGroups || []) { const name = String(group.TargetGroupName || ""); if (!/^(deployguard|dg)-/i.test(name)) continue; const arn = String(group.TargetGroupArn); this.add(resources, { resourceKey: arn, arn, name, resourceType: "target_group", awsService: "elasticloadbalancing", region: this.region, source: "naming_prefix" }); }
  }

  private async discoverEc2(resources: Map<string, DiscoveredCloudResource>, warnings: string[]) {
    const specs = [
      ["describe-vpcs", "Vpcs", "VpcId", "vpc"], ["describe-subnets", "Subnets", "SubnetId", "subnet"], ["describe-route-tables", "RouteTables", "RouteTableId", "route_table"],
      ["describe-internet-gateways", "InternetGateways", "InternetGatewayId", "internet_gateway"], ["describe-nat-gateways", "NatGateways", "NatGatewayId", "nat_gateway"],
      ["describe-addresses", "Addresses", "AllocationId", "elastic_ip"], ["describe-security-groups", "SecurityGroups", "GroupId", "security_group"], ["describe-network-interfaces", "NetworkInterfaces", "NetworkInterfaceId", "network_interface"],
    ];
    for (const [command, listKey, idKey, type] of specs) {
      const payload = await this.tryJson(["ec2", command, "--filters", "Name=tag:ManagedBy,Values=DeployGuard", "--output", "json"], warnings, `EC2 ${type} discovery`);
      for (const item of payload[listKey] || []) { const id = String(item[idKey] || ""); if (!id) continue; const tags = this.tags(item.Tags); this.add(resources, { resourceKey: `${type}:${id}`, arn: null, name: id, resourceType: type, awsService: "ec2", region: this.region, tags, source: "discovered_tag", metadata: type === "nat_gateway" ? { state: item.State || null } : undefined }); }
    }
  }

  private async discoverEfs(resources: Map<string, DiscoveredCloudResource>, warnings: string[]) {
    const payload = await this.tryJson(["efs", "describe-file-systems", "--output", "json"], warnings, "EFS discovery");
    for (const fs of payload.FileSystems || []) { const name = String(fs.Name || ""); if (!/^(deployguard|dg)-/i.test(name)) continue; const id = String(fs.FileSystemId); const arn = String(fs.FileSystemArn || id); this.add(resources, { resourceKey: arn, arn, name: name || id, resourceType: "efs", awsService: "elasticfilesystem", region: this.region, source: "naming_prefix", metadata: { sizeBytes: fs.SizeInBytes?.Value || null, lifecycleState: fs.LifeCycleState || null } }); const accessPoints = await this.tryJson(["efs", "describe-access-points", "--file-system-id", id, "--output", "json"], warnings, `EFS access points for ${id}`, true); for (const point of accessPoints.AccessPoints || []) { const pointId = String(point.AccessPointId || ""); if (pointId) this.add(resources, { resourceKey: String(point.AccessPointArn || pointId), arn: String(point.AccessPointArn || "") || null, name: pointId, resourceType: "efs_access_point", awsService: "elasticfilesystem", region: this.region, source: "naming_prefix", metadata: { fileSystemId: id } }); } const targets = await this.tryJson(["efs", "describe-mount-targets", "--file-system-id", id, "--output", "json"], warnings, `EFS mount targets for ${id}`, true); for (const target of targets.MountTargets || []) { const targetId = String(target.MountTargetId || ""); if (targetId) this.add(resources, { resourceKey: `efs-mount-target:${targetId}`, arn: null, name: targetId, resourceType: "efs_mount_target", awsService: "elasticfilesystem", region: this.region, source: "naming_prefix", metadata: { fileSystemId: id, subnetId: target.SubnetId || null, lifeCycleState: target.LifeCycleState || null } }); } }
  }

  private async discoverIam(resources: Map<string, DiscoveredCloudResource>, warnings: string[]) {
    const roles = await this.tryJson(["iam", "list-roles", "--output", "json"], warnings, "IAM role discovery");
    for (const role of roles.Roles || []) { const name = String(role.RoleName || ""); if (!/^(deployguard|dg)-/i.test(name) && !String(role.Path || "").startsWith("/deployguard/")) continue; const arn = String(role.Arn); this.add(resources, { resourceKey: arn, arn, name, resourceType: "iam_role", awsService: "iam", region: "global", source: "naming_prefix" }); }
    const policies = await this.tryJson(["iam", "list-policies", "--scope", "Local", "--output", "json"], warnings, "IAM policy discovery");
    for (const policy of policies.Policies || []) { const name = String(policy.PolicyName || ""); if (!/^(deployguard|dg)-/i.test(name) && !String(policy.Path || "").startsWith("/deployguard/")) continue; const arn = String(policy.Arn); this.add(resources, { resourceKey: arn, arn, name, resourceType: "iam_policy", awsService: "iam", region: "global", source: "naming_prefix" }); }
  }

  private async discoverState(resources: Map<string, DiscoveredCloudResource>, warnings: string[]) {
    const bucket = this.config.get<string>("TERRAFORM_STATE_BUCKET", "deployguard-state-bucket");
    this.add(resources, { resourceKey: `s3://${bucket}`, arn: `arn:aws:s3:::${bucket}`, name: bucket, resourceType: "state_bucket", awsService: "s3", region: this.region, source: "state_backend" });
    if (bucket !== "deployguard-state-bucket") { warnings.push("Configured Terraform state bucket differs from deployguard-state-bucket; state cleanup is disabled."); return; }
    const payload = await this.tryJson(["s3api", "list-objects-v2", "--bucket", bucket, "--prefix", "projects/", "--output", "json"], warnings, "Terraform state object discovery");
    for (const object of payload.Contents || []) {
      const key = String(object.Key || "");
      if (!key) continue;
      const lockfile = key.endsWith(".tflock");
      let stale = false;
      if (lockfile) {
        const projectId = key.match(/^projects\/([0-9a-f-]{36})\//i)?.[1];
        const environment = key.match(/terraform\.([^.\/]+)\.tfstate\.tflock$/)?.[1] || "dev";
        if (projectId) {
          try {
            const lock = await this.terraformState.inspectNativeLockfile({ id: projectId }, environment);
            stale = Boolean(lock.exists && lock.stale && lock.key === key);
          } catch (error) {
            warnings.push(`Terraform lockfile verification: ${this.aws.sanitize(error instanceof Error ? error.message : String(error)).slice(0, 500)}`);
          }
        }
      }
      this.add(resources, { resourceKey: `s3://${bucket}/${key}`, arn: null, name: key, resourceType: lockfile ? "terraform_lockfile" : "terraform_state", awsService: "s3", region: this.region, source: "state_backend", metadata: { lastModified: object.LastModified || null, size: object.Size || 0, stale } });
    }
  }

  private discoverStateBackups(resources: Map<string, DiscoveredCloudResource>, operations: DestroyOperation[]) {
    for (const operation of operations) {
      if (!operation.stateBackupReference || operation.stateBackupReference.startsWith("demo:")) continue;
      const key = this.terraformState.buildStateKey({ id: operation.projectId }, operation.environmentName || "dev");
      this.add(resources, { resourceKey: `s3-version:${operation.projectId}:${operation.stateBackupReference}`, arn: null, name: `${key} version ${operation.stateBackupReference}`, resourceType: "terraform_state_backup", awsService: "s3", region: this.region, source: "state_backend", projectId: operation.projectId, metadata: { stateKey: key, versionId: operation.stateBackupReference, destroyOperationId: operation.id, recordedAt: operation.createdAt } });
    }
  }

  private async updateProjectStatuses(projects: Project[], environments: Map<string, ProjectInfrastructureEnvironment>) {
    const activeRecords = await this.records.find();
    for (const project of projects) {
      const environment = environments.get(project.id); if (!environment) continue;
      const resources = activeRecords.filter((resource) => resource.projectId === project.id && resource.status !== "deleted" && !resource.protected);
      const manual = resources.some((resource) => resource.status === "manual_review" || !resource.safeToCleanup && resource.status === "cleanup_required");
      const destroyed = ["destroyed", "destroy_needs_cleanup", "destroy_failed"].includes(environment.status);
      const resourceStatus = !resources.length ? "no_cloud_resources_found" : manual ? "manual_review_required" : destroyed ? "cleanup_required" : "live";
      environment.metadata = { ...(environment.metadata || {}), cloudResourceStatus: resourceStatus, cloudResourceCount: resources.length, cloudHighCostResourceCount: resources.filter((resource) => resource.costRisk === "high").length, cloudInventoryLastSeenAt: new Date().toISOString() };
      if (destroyed && resources.length && environment.status === "destroyed") environment.status = "destroy_needs_cleanup";
      await this.environments.save(environment);
    }
  }

  private safeResource(resource: CentralCloudResource) { return { id: resource.id, resourceKey: resource.resourceKey, arn: resource.arn, name: resource.resourceName, type: resource.resourceType, awsService: resource.awsService, region: resource.region, projectId: resource.projectId, pipelineRunId: resource.pipelineRunId, projectName: String(resource.metadata?.projectName || "") || null, source: resource.source, ownership: resource.ownership, cleanupEligibility: resource.cleanupEligibility, status: resource.status, costRisk: resource.costRisk, safeToCleanup: resource.safeToCleanup, cleanupSupported: resource.cleanupSupported, protected: resource.protected, reason: resource.reason, firstSeen: resource.firstSeenAt, lastSeen: resource.lastSeenAt, deletedAt: resource.deletedAt, metadata: this.safeMetadata(resource.metadata || {}) }; }
  private groupResources(resources: Array<any>) {
    const projects = new Map<string, any>();
    for (const resource of resources.filter((item) => item.status !== "deleted")) {
      const projectKey = resource.projectId || "unmapped";
      if (!projects.has(projectKey)) projects.set(projectKey, { projectId: resource.projectId, projectName: resource.projectName || (resource.projectId ? "Known project" : "Unmapped"), terraformStack: [], directCleanup: { ecrRepositories: [], logs: [], secrets: [], oldTaskDefinitions: [] }, protected: [], manualReview: [], highCostCount: 0 });
      const group = projects.get(projectKey);
      if (resource.costRisk === "high" && !resource.protected) group.highCostCount += 1;
      if (["ecr_image", "ecr_lifecycle_policy"].includes(resource.type)) continue;
      if (resource.cleanupEligibility === "terraform_destroy") group.terraformStack.push(resource);
      else if (resource.protected || resource.cleanupEligibility === "protected") group.protected.push(resource);
      else if (resource.cleanupEligibility === "manual_review") group.manualReview.push(resource);
      else if (resource.type === "ecr_repository") group.directCleanup.ecrRepositories.push({ ...resource, children: resources.filter((child) => ["ecr_image", "ecr_lifecycle_policy"].includes(child.type) && child.projectId === resource.projectId && (child.name.startsWith(`${resource.name}:`) || child.resourceKey.includes(resource.name))) });
      else if (resource.type === "log_group") group.directCleanup.logs.push(resource);
      else if (resource.type === "secret") group.directCleanup.secrets.push(resource);
      else if (resource.type === "ecs_task_definition") group.directCleanup.oldTaskDefinitions.push(resource);
    }
    return [...projects.values()];
  }
  private safeMetadata(value: Record<string, unknown>) { const blocked = /secret|token|password|credential|value|authorization|cookie/i; return Object.fromEntries(Object.entries(value).filter(([key]) => !blocked.test(key)).map(([key, item]) => [key, typeof item === "string" ? this.aws.sanitize(item).slice(0, 500) : item])); }
  private add(map: Map<string, DiscoveredCloudResource>, resource: DiscoveredCloudResource) { const duplicateEntry = [...map.entries()].find(([, current]) => current.resourceType === resource.resourceType && current.name === resource.name); const key = map.has(resource.resourceKey) ? resource.resourceKey : duplicateEntry?.[0] || resource.resourceKey; const existing = map.get(key); const source = resource.source === "terraform" ? "terraform" : existing?.source === "discovered_tag" ? "discovered_tag" : resource.source; map.set(key, { ...existing, ...resource, resourceKey: key, source, projectId: resource.projectId || existing?.projectId || null, tags: { ...(existing?.tags || {}), ...(resource.tags || {}) }, metadata: { ...(existing?.metadata || {}), ...(resource.metadata || {}) } }); }
  private async reconcileTerraformProof(resources: CentralCloudResource[], environments: ProjectInfrastructureEnvironment[]) {
    const eligible = new Set(["vpc", "subnet", "route_table", "internet_gateway", "nat_gateway", "elastic_ip", "security_group", "load_balancer", "listener", "target_group", "ecs_cluster", "ecs_service", "ecs_task_definition", "cloud_map_namespace", "cloud_map_service", "event_rule", "efs", "efs_access_point", "efs_mount_target", "iam_role", "iam_policy"]);
    const latest = new Map<string, ProjectInfrastructureEnvironment>();
    for (const environment of environments) if (!latest.has(environment.projectId)) latest.set(environment.projectId, environment);
    const changed: CentralCloudResource[] = [];
    for (const resource of resources) {
      let typeChanged = false;
      if (resource.resourceType === "other" && resource.arn) {
        const classifiedType = this.typeFromArn(resource.arn);
        if (classifiedType !== "other") {
          resource.resourceType = classifiedType;
          typeChanged = true;
        }
      }
      if (!resource.projectId || resource.protected || !eligible.has(resource.resourceType)) {
        if (typeChanged) changed.push(resource);
        continue;
      }
      const environment = latest.get(resource.projectId); if (!environment) continue;
      const evidence = JSON.stringify({ outputs: environment.terraformOutputs || {}, vpcId: environment.vpcId, publicSubnetIds: environment.publicSubnetIds, privateSubnetIds: environment.privateSubnetIds, internetGatewayId: environment.internetGatewayId, natGatewayIds: environment.natGatewayIds, routeTableIds: environment.routeTableIds, albSecurityGroupId: environment.albSecurityGroupId, appSecurityGroupId: environment.appSecurityGroupId, internalSecurityGroupId: environment.internalSecurityGroupId });
      const exactManagedTags = resource.source === "discovered_tag" && resource.tags?.ManagedBy === "DeployGuard" && [resource.tags?.ProjectId, resource.tags?.DeployGuardProjectId].includes(resource.projectId);
      const hasProjectStateProof = Boolean(environment.terraformStateKey || Object.keys(environment.terraformOutputs || {}).length);
      const proven = Boolean(resource.resourceName && evidence.includes(resource.resourceName)) || Boolean(resource.arn && evidence.includes(resource.arn)) || exactManagedTags && hasProjectStateProof;
      if (!proven) {
        if (typeChanged) changed.push(resource);
        continue;
      }
      resource.source = "terraform"; resource.cleanupEligibility = "terraform_destroy"; resource.safeToCleanup = false; resource.cleanupSupported = false;
      resource.reason = "Terraform-managed resource. Run project-scoped Terraform destroy. Direct deletion is disabled to avoid dependency issues.";
      if (resource.status === "manual_review") resource.status = ["destroyed", "destroy_needs_cleanup", "destroy_failed"].includes(environment.status) ? "cleanup_required" : "active";
      changed.push(resource);
    }
    if (changed.length) await this.records.save(changed);
  }
  private tags(tags: Tag[] = []) { return Object.fromEntries(tags.map((tag) => [String(tag.Key || ""), String(tag.Value || "")])); }
  private typeFromArn(arn: string) { if (arn.includes(":ecr:")) return "ecr_repository"; if (arn.includes(":secretsmanager:")) return "secret"; if (arn.includes(":logs:")) return "log_group"; if (arn.includes(":events:") && arn.includes(":rule/")) return "event_rule"; if (arn.includes(":servicediscovery:") && arn.includes(":namespace/")) return "cloud_map_namespace"; if (arn.includes(":servicediscovery:") && arn.includes(":service/")) return "cloud_map_service"; if (arn.includes(":ecs:") && arn.includes("task-definition/")) return "ecs_task_definition"; if (arn.includes(":ecs:") && arn.includes(":task/")) return "ecs_task"; if (arn.includes(":ecs:") && arn.includes("service/")) return "ecs_service"; if (arn.includes(":ecs:") && arn.includes("cluster/")) return "ecs_cluster"; if (arn.includes(":elasticloadbalancing:") && arn.includes("loadbalancer/")) return "load_balancer"; if (arn.includes(":elasticloadbalancing:") && arn.includes("targetgroup/")) return "target_group"; if (arn.includes(":elasticloadbalancing:") && arn.includes("listener/")) return "listener"; if (arn.includes(":elasticfilesystem:")) return "efs"; if (arn.includes(":iam:") && arn.includes(":role/")) return "iam_role"; if (arn.includes(":iam:") && arn.includes(":policy/")) return "iam_policy"; if (arn.includes(":ec2:") && arn.includes("natgateway/")) return "nat_gateway"; if (arn.includes(":ec2:") && arn.includes("elastic-ip/")) return "elastic_ip"; if (arn.includes(":ec2:") && arn.includes("network-interface/")) return "network_interface"; if (arn.includes(":ec2:") && arn.includes("subnet/")) return "subnet"; if (arn.includes(":ec2:") && arn.includes("route-table/")) return "route_table"; if (arn.includes(":ec2:") && arn.includes("internet-gateway/")) return "internet_gateway"; if (arn.includes(":ec2:") && arn.includes("security-group/")) return "security_group"; if (arn.includes(":ec2:") && arn.includes("vpc/")) return "vpc"; return "other"; }
  private serviceFromArn(arn: string) { return arn.split(":")[2] || "unknown"; }
  private regionFromArn(arn: string) { return arn.split(":")[3] || (arn.includes(":iam:") || arn.includes(":s3:") ? "global" : this.region); }
  private arnName(arn: string) { return arn.split(/[/:]/).filter(Boolean).pop() || arn; }
  private nameFromArn(arn: string) { if (arn.includes(":logs:") && arn.includes(":log-group:")) return arn.split(":log-group:")[1].replace(/:\*$/, ""); if (arn.includes(":secretsmanager:") && arn.includes(":secret:")) return arn.split(":secret:")[1].replace(/-[A-Za-z0-9]{6}$/, ""); if (arn.includes("task-definition/")) return arn.split("task-definition/")[1].split(":")[0]; return this.arnName(arn); }
  private get region() { return this.config.get<string>("AWS_REGION", "us-east-1"); }
  private async tryJson(args: string[], warnings: string[], label: string, ignoreMissing = false): Promise<Record<string, any>> { try { const result = await this.aws.run(args); return JSON.parse(result.stdout || "{}"); } catch (error) { const message = error instanceof Error ? error.message : String(error); if (!ignoreMissing || !/not found|notfound|does not exist/i.test(message)) warnings.push(`${label}: ${this.aws.sanitize(message).slice(0, 500)}`); return {}; } }
}
