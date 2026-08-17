import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Queue } from "bullmq";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { Request } from "express";
import { In, LessThanOrEqual, Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { InfrastructureEnvironmentStatus, InfrastructureEnvironmentType, ProjectInfrastructureEnvironment } from "../infrastructure/project-infrastructure-environment.entity";
import { ProjectPipelineEvent } from "../projects/project-pipeline-event.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { Project } from "../projects/project.entity";
import { PIPELINE_IN_PROGRESS_STATUSES } from "../projects/pipeline/pipeline-status";
import { StateLockService } from "../state-management/state-lock.service";
import { TerraformStateService } from "../state-management/terraform-state.service";
import { ProjectPersistentStorage } from "../storage/project-persistent-storage.entity";
import { ProjectDatabaseTier } from "../projects/project-database-tier.entity";
import { User, UserRole } from "../users/user.entity";
import { DestroyChallenge } from "./destroy-challenge.entity";
import { DestroyOperation } from "./destroy-operation.entity";
import { ExecuteDestroyDto } from "./dto/execute-destroy.dto";
import { ExecuteAdminCleanupDto } from "./dto/execute-admin-cleanup.dto";
import { LIFECYCLE_QUEUE, LifecycleJob } from "./lifecycle.queue";
import { ProjectCloudInventoryService } from "./project-cloud-inventory.service";
import { ProjectResourceRegistryService } from "../resource-registry/project-resource-registry.service";
import { CloudInventoryScan } from "./cloud-inventory-scan.entity";
import { UpdateEnvironmentTtlDto } from "./dto/update-environment-ttl.dto";
import { CentralCloudInventoryService } from "./central-cloud-inventory.service";
import { CloudStateReconciliationService } from "./cloud-state-reconciliation.service";

@Injectable()
export class InfrastructureLifecycleService {
  constructor(
    @InjectRepository(Project) private readonly projects: Repository<Project>,
    @InjectRepository(ProjectInfrastructureEnvironment) private readonly environments: Repository<ProjectInfrastructureEnvironment>,
    @InjectRepository(ProjectPersistentStorage) private readonly storage: Repository<ProjectPersistentStorage>,
    @InjectRepository(ProjectDatabaseTier) private readonly databaseTiers: Repository<ProjectDatabaseTier>,
    @InjectRepository(ProjectPipelineRun) private readonly runs: Repository<ProjectPipelineRun>,
    @InjectRepository(DestroyChallenge) private readonly challenges: Repository<DestroyChallenge>,
    @InjectRepository(DestroyOperation) private readonly operations: Repository<DestroyOperation>,
    @InjectRepository(ProjectPipelineEvent) private readonly events: Repository<ProjectPipelineEvent>,
    @InjectRepository(CloudInventoryScan) private readonly inventoryScans: Repository<CloudInventoryScan>,
    @Inject(LIFECYCLE_QUEUE) private readonly queue: Queue<LifecycleJob>,
    private readonly locks: StateLockService,
    private readonly terraformState: TerraformStateService,
    private readonly config: ConfigService,
    private readonly audit: AuditLogService,
    private readonly cloudInventory: ProjectCloudInventoryService,
    private readonly resourceRegistry: ProjectResourceRegistryService,
    private readonly centralInventory: CentralCloudInventoryService,
    private readonly cloudState: CloudStateReconciliationService,
  ) {}

  async review(user: User, projectId: string, environmentName = "dev") {
    const { project, environment } = await this.context(user, projectId, environmentName);
    const [persistent, databaseTier] = await Promise.all([this.storage.find({ where: { projectId } }), this.databaseTiers.findOne({ where: { projectId } })]);
    const [activeRun, activeDestroy] = await Promise.all([
      this.runs.findOne({ where: { projectId, status: In([...PIPELINE_IN_PROGRESS_STATUSES]) } }),
      this.operations.findOne({ where: { projectId, environmentName, status: In(["queued", "running"]) } }),
    ]);
    const lock = await this.locks.getLock(this.locks.buildLockId(projectId, environmentName));
    const enabled = this.config.get<string>("DESTROY_ENABLED", "false") === "true";
    const demoMode = this.config.get<string>("DESTROY_DEMO_MODE", "false") === "true";
    let backend: { bucket: string; stateKey: string; lockfileKey: string; region: string } | null = null;
    let backendError: string | null = null;
    if (enabled) {
      try {
        const validated = await this.terraformState.validateDestroyBackend(project, environmentName);
        backend = { bucket: validated.bucket, stateKey: validated.stateKey, lockfileKey: validated.lockfileKey, region: validated.region };
        if (environment.terraformStateKey && environment.terraformStateKey !== validated.stateKey) {
          throw new Error(`Infrastructure destroy is restricted to project state key ${validated.stateKey}.`);
        }
      } catch (error) {
        backendError = this.destroyError(error);
      }
    }
    const blockers = [
      activeRun ? "An active deployment must finish or be cancelled first." : null,
      activeDestroy ? "A destroy operation is already queued or running." : null,
      lock && ["acquired", "heartbeat_active"].includes(lock.status) ? "Terraform state is locked. Another operation may be running." : null,
      !enabled && !demoMode ? "Infrastructure destroy is disabled by server configuration." : null,
      backendError,
    ].filter((value): value is string => Boolean(value));
    return {
      project: { id: project.id, name: project.name },
      environment: { id: environment.id, name: environment.environmentName, status: environment.status, region: environment.awsRegion, pipelineRunId: environment.pipelineRunId, environmentType: environment.environmentType, ttlExpiresAt: environment.ttlExpiresAt, autoDestroyEnabled: environment.autoDestroyEnabled, cleanupStatus: environment.cleanupStatus },
      backend: backend || { bucket: "deployguard-state-bucket", stateKey: `projects/${project.id}/terraform.tfstate`, lockfileKey: `projects/${project.id}/terraform.tfstate.tflock`, region: environment.awsRegion || "us-east-1" },
      mode: enabled ? "live" : demoMode ? "demo" : "disabled",
      canRequest: (enabled || demoMode) && blockers.length === 0,
      blockers,
      preservation: { persistentStorage: persistent.map((item) => ({ id: item.id, fileSystemId: item.efsFileSystemId, status: item.status })), databaseStorage: databaseTier ? { fileSystemId: databaseTier.efsFileSystemId, preservedByDefault: true } : null, policy: "Database EFS, its access point, mount targets, KMS key, and backup vault are preserved by default. Deleting database data requires the separate exact phrase DELETE PERSISTENT DATABASE DATA. The shared Terraform state bucket is never a destroy target." },
    };
  }

  async issueChallenge(user: User, projectId: string, environmentName = "dev", req?: Request) {
    const review = await this.review(user, projectId, environmentName);
    if (!review.canRequest) throw new ConflictException(review.blockers.join(" ") || "Destroy is not available.");
    this.assertRecentAuthentication(user);
    const token = randomBytes(32).toString("base64url");
    const confirmationPhrase = "DESTROY";
    const challenge = await this.challenges.save(this.challenges.create({ projectId, userId: user.id, environmentName, tokenHash: this.hash(token), confirmationPhrase, expiresAt: new Date(Date.now() + 5 * 60_000), usedAt: null }));
    await this.audit.record({ actorUser: user, action: "INFRASTRUCTURE_DESTROY_CHALLENGE_ISSUED", resourceType: "project", resourceId: projectId, status: "success", metadata: { environmentName, challengeId: challenge.id }, req });
    return { challengeId: challenge.id, challengeToken: token, confirmationPhrase, expiresAt: challenge.expiresAt };
  }

  async execute(user: User, projectId: string, dto: ExecuteDestroyDto, req?: Request) {
    const review = await this.review(user, projectId, dto.environmentName);
    if (!review.canRequest) throw new ConflictException(review.blockers.join(" ") || "Destroy is not available.");
    this.assertRecentAuthentication(user);
    const challenge = await this.challenges.findOne({ where: { id: dto.challengeId, projectId, userId: user.id } });
    if (!challenge || challenge.usedAt || challenge.expiresAt.getTime() <= Date.now()) throw new BadRequestException("Destroy challenge is invalid, expired, or already used.");
    const supplied = Buffer.from(this.hash(dto.challengeToken)); const expected = Buffer.from(challenge.tokenHash);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || dto.confirmationPhrase !== challenge.confirmationPhrase || dto.environmentName !== challenge.environmentName) throw new BadRequestException("Destroy confirmation did not match the server-issued challenge.");
    if (dto.deletePersistentDatabaseData && dto.databaseDataConfirmation !== "DELETE PERSISTENT DATABASE DATA") throw new BadRequestException("Persistent database deletion requires the exact confirmation phrase.");
    challenge.usedAt = new Date(); await this.challenges.save(challenge);
    const operation = await this.operations.save(this.operations.create({ projectId, userId: user.id, infrastructureEnvironmentId: review.environment.id, environmentName: dto.environmentName, status: "queued", queueJobId: null, stateBackupReference: null, preservedResources: null, destroyedResources: null, deletePersistentDatabaseData: dto.deletePersistentDatabaseData === true, errorMessage: null, startedAt: null, completedAt: null }));
    await this.persistEvent(projectId, review.environment.pipelineRunId, "requested", "Terraform destroy was explicitly requested by an authorized user.", operation.id);
    await this.audit.record({ actorUser: user, action: "INFRASTRUCTURE_DESTROY_REQUESTED", resourceType: "infrastructure_destroy", resourceId: operation.id, status: "success", metadata: { projectId, pipelineRunId: review.environment.pipelineRunId, environmentName: dto.environmentName }, req });
    if (review.mode === "live") {
      await this.persistEvent(projectId, review.environment.pipelineRunId, "state_backup_started", "Recording the current versioned Terraform state before destroy.", operation.id);
      try {
        const backup = await this.terraformState.recordDestroyStateBackup({
          project: { id: projectId },
          environment: await this.environments.findOne({ where: { id: review.environment.id, projectId } }),
          environmentName: dto.environmentName,
          pipelineRunId: review.environment.pipelineRunId,
          operationId: operation.id,
        });
        operation.stateBackupReference = backup.versionId;
        await this.operations.save(operation);
        await this.persistEvent(projectId, review.environment.pipelineRunId, "state_backup_recorded", "Versioned Terraform state backup reference recorded.", operation.id, { bucket: backup.bucket, stateKey: backup.stateKey, versionId: backup.versionId, recordedAt: backup.recordedAt.toISOString() });
        await this.audit.record({ actorUser: user, action: "TERRAFORM_STATE_BACKUP_RECORDED", resourceType: "infrastructure_destroy", resourceId: operation.id, status: "success", metadata: { projectId, pipelineRunId: review.environment.pipelineRunId, bucket: backup.bucket, stateKey: backup.stateKey, versionId: backup.versionId, recordedAt: backup.recordedAt.toISOString() }, req });
      } catch (error) {
        operation.status = "failed";
        operation.errorMessage = this.destroyError(error);
        operation.completedAt = new Date();
        await this.operations.save(operation);
        await this.persistEvent(projectId, review.environment.pipelineRunId, "failed", operation.errorMessage, operation.id);
        await this.audit.record({ actorUser: user, action: "TERRAFORM_STATE_BACKUP_FAILED", resourceType: "infrastructure_destroy", resourceId: operation.id, status: "failed", metadata: { projectId, pipelineRunId: review.environment.pipelineRunId, reason: operation.errorMessage }, req });
        throw new BadRequestException(operation.errorMessage);
      }
    }
    try {
      const job = await this.queue.add("destroy", { operationId: operation.id }, { jobId: operation.id });
      operation.queueJobId = String(job.id); await this.operations.save(operation);
    } catch (error) {
      operation.status = "failed";
      operation.errorMessage = "Infrastructure destroy could not be queued.";
      operation.completedAt = new Date();
      await this.operations.save(operation);
      await this.persistEvent(projectId, review.environment.pipelineRunId, "failed", operation.errorMessage, operation.id);
      throw new ConflictException(operation.errorMessage);
    }
    await this.persistEvent(projectId, review.environment.pipelineRunId, "queued", "Terraform destroy is queued.", operation.id);
    await this.audit.record({ actorUser: user, action: "INFRASTRUCTURE_DESTROY_QUEUED", resourceType: "infrastructure_destroy", resourceId: operation.id, status: "success", metadata: { projectId, pipelineRunId: review.environment.pipelineRunId, environmentName: dto.environmentName }, req });
    return this.safe(operation);
  }

  async status(user: User, projectId: string, operationId?: string) { await this.context(user, projectId); const row = operationId ? await this.operations.findOne({ where: { id: operationId, projectId } }) : await this.operations.findOne({ where: { projectId }, order: { createdAt: "DESC" } }); if (!row) return null; return this.safe(row); }
  async cancel(user: User, projectId: string, operationId: string, req?: Request) { const { environment } = await this.context(user, projectId); const row = await this.operations.findOne({ where: { id: operationId, projectId } }); if (!row) throw new NotFoundException("Destroy operation not found."); if (row.status !== "queued") throw new ConflictException("Only queued destroy operations can be cancelled."); const job = await this.queue.getJob(row.queueJobId || row.id); await job?.remove(); row.status = "cancelled"; row.completedAt = new Date(); await this.operations.save(row); await this.persistEvent(projectId, environment.pipelineRunId, "cancelled", "Queued Terraform destroy was cancelled.", row.id); await this.audit.record({ actorUser: user, action: "INFRASTRUCTURE_DESTROY_CANCELLED", resourceType: "infrastructure_destroy", resourceId: row.id, status: "success", metadata: { projectId, pipelineRunId: environment.pipelineRunId }, req }); return this.safe(row); }
  async retry(user: User, projectId: string, operationId: string) { const row = await this.status(user, projectId, operationId); if (!row || row.status !== "failed") throw new ConflictException("Only failed destroy operations can be retried with a new confirmation challenge."); return this.issueChallenge(user, projectId, row.environmentName); }
  async updateTtl(user: User, projectId: string, dto: UpdateEnvironmentTtlDto, req?: Request) {
    this.assertRecentAuthentication(user);
    const { environment } = await this.context(user, projectId);
    if (dto.autoDestroyEnabled && dto.confirmationPhrase !== "SCHEDULE AUTO DESTROY") throw new BadRequestException("Type SCHEDULE AUTO DESTROY to confirm automatic cleanup.");
    if (dto.environmentType === InfrastructureEnvironmentType.PRODUCTION && dto.autoDestroyEnabled) throw new BadRequestException("Automatic destroy cannot be enabled for production environments.");
    if (environment.environmentType === InfrastructureEnvironmentType.PRODUCTION && environment.provisionedAt && dto.environmentType !== InfrastructureEnvironmentType.PRODUCTION) throw new ForbiddenException("A provisioned production environment cannot be reclassified for automatic cleanup.");
    const expiresAt = dto.autoDestroyEnabled
      ? dto.ttlHours ? new Date(Date.now() + dto.ttlHours * 60 * 60_000) : dto.ttlExpiresAt ? new Date(dto.ttlExpiresAt) : null
      : null;
    if (dto.autoDestroyEnabled && (!expiresAt || expiresAt.getTime() <= Date.now())) throw new BadRequestException("Choose a future TTL expiry time.");
    if (expiresAt && expiresAt.getTime() > Date.now() + 30 * 24 * 60 * 60_000) throw new BadRequestException("Testing and preview TTL cannot exceed 30 days.");
    environment.environmentType = dto.environmentType as InfrastructureEnvironmentType;
    environment.autoDestroyEnabled = dto.autoDestroyEnabled;
    environment.ttlExpiresAt = expiresAt;
    environment.cleanupStatus = dto.autoDestroyEnabled ? "scheduled" : "not_scheduled";
    await this.environments.save(environment);
    await this.audit.record({ actorUser: user, action: dto.autoDestroyEnabled ? "ENVIRONMENT_TTL_SCHEDULED" : "ENVIRONMENT_TTL_DISABLED", resourceType: "infrastructure_environment", resourceId: environment.id, status: "success", metadata: { projectId, environmentType: environment.environmentType, ttlExpiresAt: expiresAt?.toISOString() || null }, req });
    return { environmentType: environment.environmentType, ttlExpiresAt: environment.ttlExpiresAt, autoDestroyEnabled: environment.autoDestroyEnabled, cleanupStatus: environment.cleanupStatus };
  }

  async expiredTtlEnvironments() {
    return this.environments.find({ where: { autoDestroyEnabled: true, ttlExpiresAt: LessThanOrEqual(new Date()), environmentType: In([InfrastructureEnvironmentType.TESTING, InfrastructureEnvironmentType.PREVIEW]), cleanupStatus: In(["scheduled", "retry_pending"]) }, order: { ttlExpiresAt: "ASC" } });
  }

  async enqueueAutomatedDestroy(input: { projectId: string; environmentId: string; userId: number; source: "ttl" | "emergency"; emergencyOperationId?: string; priority?: number }) {
    const [project, environment, active] = await Promise.all([
      this.projects.findOne({ where: { id: input.projectId } }),
      this.environments.findOne({ where: { id: input.environmentId, projectId: input.projectId } }),
      this.operations.findOne({ where: { projectId: input.projectId, status: In(["queued", "running"]) } }),
    ]);
    if (!project || !environment) throw new NotFoundException("Project infrastructure environment not found.");
    if (environment.environmentType === InfrastructureEnvironmentType.PRODUCTION) throw new ForbiddenException("Automated cleanup can never target a production environment.");
    if (active) return this.safe(active);
    const live = this.config.get<string>("DESTROY_ENABLED", "false") === "true";
    const demo = this.config.get<string>("DESTROY_DEMO_MODE", "false") === "true";
    if (!live && !demo) throw new ConflictException("Infrastructure destroy is disabled by server configuration.");
    const operation = await this.operations.save(this.operations.create({ projectId: project.id, userId: input.userId, infrastructureEnvironmentId: environment.id, environmentName: environment.environmentName, source: input.source, emergencyOperationId: input.emergencyOperationId || null, status: "queued", queueJobId: null, stateBackupReference: null, preservedResources: null, destroyedResources: null, errorMessage: null, startedAt: null, completedAt: null }));
    environment.cleanupStatus = "queued";
    await this.environments.save(environment);
    if (live) {
      try {
        const backup = await this.terraformState.recordDestroyStateBackup({ project: { id: project.id }, environment, environmentName: environment.environmentName, pipelineRunId: environment.pipelineRunId, operationId: operation.id });
        operation.stateBackupReference = backup.versionId;
        await this.operations.save(operation);
      } catch (error) {
        operation.status = "failed"; operation.errorMessage = this.destroyError(error); operation.completedAt = new Date();
        environment.cleanupStatus = "failed";
        await Promise.all([this.operations.save(operation), this.environments.save(environment)]);
        throw new BadRequestException(operation.errorMessage);
      }
    }
    const job = await this.queue.add("destroy", { operationId: operation.id, source: input.source, emergencyOperationId: input.emergencyOperationId }, { jobId: operation.id, priority: input.priority ?? (input.source === "emergency" ? 1 : 5) });
    operation.queueJobId = String(job.id); await this.operations.save(operation);
    await this.audit.record({ action: input.source === "ttl" ? "TTL_CLEANUP_QUEUED" : "EMERGENCY_PROJECT_DESTROY_QUEUED", resourceType: "infrastructure_destroy", resourceId: operation.id, status: "success", metadata: { actorUserId: input.userId, projectId: project.id, environmentType: environment.environmentType, emergencyOperationId: input.emergencyOperationId || null } });
    return this.safe(operation);
  }
  async inventory(user: User, projectId: string) {
    this.assertAdmin(user);
    await this.context(user, projectId);
    return this.cloudInventory.scan(projectId, user);
  }
  async projectResources(user: User, projectId: string) {
    const project = await this.assertProjectAccess(user, projectId);
    await this.centralInventory.reconcileProjectTerraformProof(projectId);
    const [resources, latestScan, currentState] = await Promise.all([this.resourceRegistry.listProject(projectId), this.inventoryScans.findOne({ where: { scope: "project", projectId }, order: { completedAt: "DESC" } }), this.cloudState.current(projectId, user, false)]);
    const live = resources.filter((resource) => resource.status !== "deleted");
    const ownershipById = new Map(currentState.resourceOwnership.map((item) => [String(item.id), String(item.category)]));
    const safeResources = resources.map((resource) => ({ id: resource.id, resourceKey: resource.resourceKey, arn: resource.arn, name: resource.resourceName, category: resource.resourceType, awsService: resource.awsService, region: resource.region, pipelineRunId: resource.pipelineRunId, source: resource.source, ownership: resource.ownership, ownershipCategory: ownershipById.get(resource.id) || "unknown", cleanupEligibility: resource.cleanupEligibility, costRisk: resource.costRisk, protected: resource.protected, cleanupSupported: resource.cleanupSupported, safeToCleanup: resource.safeToCleanup, deleteStatus: resource.status, reason: resource.reason, firstSeenAt: resource.firstSeenAt, lastSeenAt: resource.lastSeenAt, deletedAt: resource.deletedAt }));
    const environment = await this.environments.findOne({ where: { projectId }, order: { updatedAt: "DESC" } });
    return {
      project: { id: project.id, name: project.name, repositoryFullName: project.repositoryFullName },
      currentState,
      resources: safeResources,
      groups: this.groupResources(safeResources),
      ttl: environment ? { environmentType: environment.environmentType, ttlExpiresAt: environment.ttlExpiresAt, autoDestroyEnabled: environment.autoDestroyEnabled, cleanupStatus: environment.cleanupStatus } : null,
      summary: { total: live.length, remaining: live.filter((resource) => !resource.protected).length, protected: live.filter((resource) => resource.protected).length, safeCleanup: live.filter((resource) => resource.safeToCleanup).length, manualReview: live.filter((resource) => resource.cleanupEligibility === "manual_review").length, highCost: live.filter((resource) => resource.costRisk === "high" && !resource.protected).length, status: !latestScan ? "not_scanned" : latestScan.errors.length ? "inventory_incomplete" : live.length ? "resources_found" : "no_project_resources_found", verified: Boolean(latestScan && latestScan.errors.length === 0) },
      scan: latestScan ? { id: latestScan.id, status: latestScan.status, servicesChecked: latestScan.servicesChecked, errors: latestScan.errors, startedAt: latestScan.startedAt, completedAt: latestScan.completedAt } : null,
    };
  }
  async refreshProjectResources(user: User, projectId: string) { await this.assertProjectAccess(user, projectId); await this.cloudInventory.scan(projectId, user); await this.cloudState.reconcile(projectId); return this.projectResources(user, projectId); }
  async projectCleanupReport(user: User, projectId: string) {
    const inventory = await this.projectResources(user, projectId);
    const header = ["Resource ID", "Name", "Type", "AWS Service", "Region", "Run ID", "Ownership", "Cleanup eligibility", "Cost risk", "Status", "Reason", "Last seen"];
    const rows = inventory.resources.map((resource) => [resource.id, resource.name, resource.category, resource.awsService, resource.region, resource.pipelineRunId || "", resource.ownership, resource.cleanupEligibility, resource.costRisk, resource.deleteStatus, resource.reason, resource.lastSeenAt]);
    const csv = [header, ...rows].map((row) => row.map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    return { filename: `deployguard-${projectId}-resources-${new Date().toISOString().slice(0, 10)}.csv`, csv };
  }
  async issueCleanupChallenge(user: User, projectId: string, environmentName = "dev", req?: Request) {
    this.assertAdmin(user); this.assertRecentAuthentication(user);
    await this.context(user, projectId, environmentName);
    const operation = await this.operations.findOne({ where: { projectId, environmentName }, order: { createdAt: "DESC" } });
    if (!operation || operation.status !== "completed") throw new ConflictException("Terraform destroy must complete before cleaning cloud residue.");
    const token = randomBytes(32).toString("base64url");
    const confirmationPhrase = "DELETE CLOUD RESOURCES";
    const challenge = await this.challenges.save(this.challenges.create({ projectId, userId: user.id, environmentName, tokenHash: this.hash(token), confirmationPhrase, expiresAt: new Date(Date.now() + 5 * 60_000), usedAt: null }));
    await this.audit.record({ actorUser: user, action: "ADMIN_CLOUD_CLEANUP_CHALLENGE_ISSUED", resourceType: "project", resourceId: projectId, status: "success", metadata: { projectId, environmentName, challengeId: challenge.id }, req });
    return { challengeId: challenge.id, challengeToken: token, confirmationPhrase, expiresAt: challenge.expiresAt };
  }
  async executeCleanup(user: User, projectId: string, dto: ExecuteAdminCleanupDto, req?: Request) {
    this.assertAdmin(user); this.assertRecentAuthentication(user);
    const { environment } = await this.context(user, projectId, dto.environmentName);
    const challenge = await this.challenges.findOne({ where: { id: dto.challengeId, projectId, userId: user.id } });
    if (!challenge || challenge.usedAt || challenge.expiresAt.getTime() <= Date.now()) throw new BadRequestException("Cleanup challenge is invalid, expired, or already used.");
    const supplied = Buffer.from(this.hash(dto.challengeToken)); const expected = Buffer.from(challenge.tokenHash);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || dto.confirmationPhrase !== "DELETE CLOUD RESOURCES" || dto.confirmationPhrase !== challenge.confirmationPhrase || dto.environmentName !== challenge.environmentName) throw new BadRequestException("Cloud cleanup confirmation did not match the server-issued challenge.");
    challenge.usedAt = new Date(); await this.challenges.save(challenge);
    const operation = await this.operations.findOne({ where: { projectId, environmentName: dto.environmentName }, order: { createdAt: "DESC" } });
    if (!operation || operation.status !== "completed") throw new ConflictException("Terraform destroy must complete before cleaning cloud residue.");
    operation.cleanupStatus = "running"; operation.cleanupRequestedAt = new Date(); operation.cleanupResult = null; await this.operations.save(operation);
    await this.audit.record({ actorUser: user, action: "ADMIN_CLOUD_CLEANUP_REQUESTED", resourceType: "infrastructure_destroy", resourceId: operation.id, status: "success", metadata: { projectId, pipelineRunId: environment.pipelineRunId, selectedResourceCount: dto.selectedResourceIds?.length || null }, req });
    try {
      const result = await this.cloudInventory.cleanup(projectId, dto.selectedResourceIds, user, operation.id);
      operation.resourceInventory = result.inventory as unknown as Record<string, unknown>;
      operation.cleanupResult = { results: result.results };
      operation.cleanupCompletedAt = new Date();
      operation.cleanupStatus = result.inventory.summary.verified && result.inventory.summary.remaining === 0 ? "completed" : "cleanup_required";
      environment.status = operation.cleanupStatus === "completed" ? InfrastructureEnvironmentStatus.DESTROYED : InfrastructureEnvironmentStatus.DESTROY_NEEDS_CLEANUP;
      environment.errorMessage = operation.cleanupStatus === "completed" ? null : "Some project cloud resources remain after cleanup verification.";
      await Promise.all([this.operations.save(operation), this.environments.save(environment)]);
      await this.persistEvent(projectId, environment.pipelineRunId, operation.cleanupStatus === "completed" ? "cleanup_completed" : "cleanup_required", operation.cleanupStatus === "completed" ? "Cloud residue cleanup completed and verification found no project resources." : "Some project cloud resources remain after cleanup verification.", operation.id, { remainingCount: result.inventory.summary.remaining });
      await this.audit.record({ actorUser: user, action: operation.cleanupStatus === "completed" ? "ADMIN_CLOUD_CLEANUP_COMPLETED" : "ADMIN_CLOUD_CLEANUP_INCOMPLETE", resourceType: "infrastructure_destroy", resourceId: operation.id, status: operation.cleanupStatus === "completed" ? "success" : "warning", metadata: { projectId, pipelineRunId: environment.pipelineRunId, remainingCount: result.inventory.summary.remaining, verified: result.inventory.summary.verified }, req });
      return this.safe(operation);
    } catch (error) {
      operation.cleanupStatus = "failed"; operation.cleanupCompletedAt = new Date(); operation.cleanupResult = { error: this.destroyError(error) }; await this.operations.save(operation);
      await this.audit.record({ actorUser: user, action: "ADMIN_CLOUD_CLEANUP_FAILED", resourceType: "infrastructure_destroy", resourceId: operation.id, status: "failed", metadata: { projectId, pipelineRunId: environment.pipelineRunId, reason: this.destroyError(error) }, req });
      throw error;
    }
  }
  validateWorkspace(workspace: string, allowedRoot: string) { const root = require("path").resolve(allowedRoot); const candidate = require("path").resolve(workspace); if (candidate !== root && !candidate.startsWith(`${root}${require("path").sep}`)) throw new Error("Terraform workspace is outside the configured DeployGuard workspace root."); return candidate; }
  filterDestroyTargets(addresses: string[], deletePersistentDatabaseData = false) {
    const reusableSecrets = /module\.(?:database_service\.(?:aws_secretsmanager_secret(?:_version)?\.(?:password|url)|random_password\.database)|ecs_service\.aws_secretsmanager_secret(?:_version)?\.environment)/;
    const persistentDatabaseData = /module\.database_service\.(?:aws_efs_file_system\.database|aws_efs_(?:access_point|mount_target)\.database|aws_kms_key\.efs|aws_backup_(?:vault|plan|selection)\.database|aws_iam_(?:role|role_policy_attachment)\.backup)/;
    const preserved = addresses.filter((address) => reusableSecrets.test(address) || (!deletePersistentDatabaseData && persistentDatabaseData.test(address)));
    return { targets: addresses.filter((address) => !preserved.includes(address)), preserved };
  }
  assertSharedStateBucketNotTracked(rawState: string, bucket = "deployguard-state-bucket") {
    let parsed: { resources?: Array<{ type?: string; instances?: Array<{ attributes?: Record<string, unknown> }> }> };
    try { parsed = JSON.parse(rawState); } catch { throw new Error("Terraform state could not be validated safely."); }
    const tracksSharedBucket = (parsed.resources || []).some((resource) => resource.type === "aws_s3_bucket" && (resource.instances || []).some((instance) => {
      const attributes = instance.attributes || {};
      return [attributes.bucket, attributes.id, attributes.arn].some((value) => typeof value === "string" && (value === bucket || value === `arn:aws:s3:::${bucket}`));
    }));
    if (tracksSharedBucket) throw new Error("Destroy refused because the shared Terraform state bucket appears in the project's Terraform state.");
  }
  private async context(user: User, projectId: string, environmentName = "dev") { const project = await this.projects.findOne({ where: { id: projectId } }); if (!project) throw new NotFoundException("Project not found."); if (user.role !== UserRole.ADMIN && project.ownerUserId !== user.id) throw new ForbiddenException("You cannot manage this project."); if (user.role === UserRole.READONLY) throw new ForbiddenException("Read-only users cannot destroy infrastructure."); const environment = await this.environments.findOne({ where: { projectId, environmentName }, order: { updatedAt: "DESC" } }); if (!environment) throw new NotFoundException("Infrastructure environment not found."); return { project, environment }; }
  private async assertProjectAccess(user: User, projectId: string) { const project = await this.projects.findOne({ where: { id: projectId } }); if (!project) throw new NotFoundException("Project not found."); if (user.role !== UserRole.ADMIN && project.ownerUserId !== user.id) throw new ForbiddenException("You cannot manage this project."); return project; }
  private assertRecentAuthentication(user: User) { const maxAge = Number(this.config.get<string>("DESTROY_RECENT_AUTH_MINUTES", "15")) * 60_000; if (!user.lastLoginAt || Date.now() - new Date(user.lastLoginAt).getTime() > maxAge) throw new ForbiddenException("Recent authentication is required before destroying infrastructure. Sign in again."); }
  private assertAdmin(user: User) { if (user.role !== UserRole.ADMIN) throw new ForbiddenException("Admin permission is required for cloud residue cleanup."); }
  private hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
  private async persistEvent(projectId: string, pipelineRunId: string | null, status: string, message: string, operationId: string, metadata: Record<string, unknown> = {}) {
    if (!pipelineRunId) return;
    const stage = status.startsWith("state_backup_") ? `terraform_${status}` : `terraform_destroy_${status}`;
    await this.events.save(this.events.create({ projectId, pipelineRunId, stage, status, message, metadata: { operationId, ...metadata } }));
  }
  private destroyError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (/state object not found|No Terraform state was found/i.test(message)) return "Terraform state object not found.";
    if (/versioning is not enabled/i.test(message)) return "Terraform state bucket versioning is not enabled. Enable versioning before live destroy.";
    if (/backup reference/i.test(message)) return "Unable to record Terraform state backup reference.";
    if (/lock/i.test(message)) return "Terraform state is locked. Another operation may be running.";
    if (/credential|AccessDenied|Forbidden|InvalidAccessKeyId|SignatureDoesNotMatch/i.test(message)) return "AWS credentials cannot read Terraform state object.";
    return message.slice(0, 1000);
  }
  private groupResources(resources: Array<any>) {
    const live = resources.filter((resource) => resource.deleteStatus !== "deleted");
    const terraform = live.filter((resource) => resource.cleanupEligibility === "terraform_destroy" && !["ecr_image", "ecr_lifecycle_policy"].includes(resource.category));
    const sectionTypes: Record<string, string[]> = { network: ["vpc", "subnet", "route_table", "internet_gateway", "nat_gateway", "elastic_ip", "security_group", "network_interface"], ecs: ["ecs_cluster", "ecs_service", "ecs_task"], alb: ["load_balancer", "listener", "target_group"], cloudMap: ["cloud_map_namespace", "cloud_map_service"], eventBridge: ["event_rule"], storageAndIam: ["efs", "efs_access_point", "efs_mount_target", "kms_key", "backup_vault", "backup_plan", "iam_role", "iam_policy"] };
    const ecrRepositories = live.filter((resource) => resource.category === "ecr_repository").map((repository) => ({ ...repository, children: live.filter((child) => ["ecr_image", "ecr_lifecycle_policy"].includes(child.category) && (child.name.startsWith(`${repository.name}:`) || child.resourceKey.includes(repository.name))) }));
    return {
      terraformStack: { count: terraform.length, sections: Object.fromEntries(Object.entries(sectionTypes).map(([key, types]) => [key, terraform.filter((resource) => types.includes(resource.category))])) },
      directCleanup: { ecrRepositories, logs: live.filter((resource) => resource.category === "log_group"), secrets: live.filter((resource) => resource.category === "secret"), oldTaskDefinitions: live.filter((resource) => resource.category === "ecs_task_definition" && resource.cleanupEligibility === "safe_cleanup") },
      protected: live.filter((resource) => resource.protected || resource.cleanupEligibility === "protected"),
      manualReview: live.filter((resource) => resource.cleanupEligibility === "manual_review"),
    };
  }
  private safe(row: DestroyOperation) { const live = this.config.get<string>("DESTROY_ENABLED", "false") === "true"; const demo = this.config.get<string>("DESTROY_DEMO_MODE", "false") === "true"; const inventory = row.resourceInventory as { summary?: unknown } | null; return { id: row.id, projectId: row.projectId, environmentName: row.environmentName, status: row.status, mode: live ? "live" : demo ? "demo" : "disabled", stateKey: this.terraformState.buildStateKey({ id: row.projectId }, row.environmentName), preservedResources: row.preservedResources, destroyedResources: row.destroyedResources, stateBackupReference: row.stateBackupReference, cleanupStatus: row.cleanupStatus, cleanupSummary: inventory?.summary || null, cleanupResult: row.cleanupResult, errorMessage: row.errorMessage, createdAt: row.createdAt, startedAt: row.startedAt, completedAt: row.completedAt, cleanupRequestedAt: row.cleanupRequestedAt, cleanupCompletedAt: row.cleanupCompletedAt }; }
}
