import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Queue } from "bullmq";
import { Request } from "express";
import { DataSource, Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { acquireProjectConfigurationAdvisoryLock } from "../infrastructure/database-service-binding.service";
import { ProjectPipelineRun, PipelineRunStatus } from "../projects/project-pipeline-run.entity";
import { PIPELINE_QUEUE, PipelineJobData } from "../projects/pipeline/pipeline.types";
import { Project, ProjectStatus, ProjectVisibility } from "../projects/project.entity";
import { User, UserRole } from "../users/user.entity";
import { BackupService } from "./backup.service";
import { EfsService } from "./efs.service";
import { ProjectPersistentStorage, PersistentStorageStatus } from "./project-persistent-storage.entity";
import { ProjectStorageEvent } from "./project-storage-event.entity";
import { getStorageConfig } from "./storage.config";
import { StoragePolicyService } from "./storage-policy.service";

type RequestInfo = Request | undefined;

@Injectable()
export class StorageService {
  constructor(
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    @InjectRepository(ProjectPipelineRun)
    private readonly runRepository: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectPersistentStorage)
    private readonly storageRepository: Repository<ProjectPersistentStorage>,
    @InjectRepository(ProjectStorageEvent)
    private readonly eventRepository: Repository<ProjectStorageEvent>,
    @Inject(PIPELINE_QUEUE)
    private readonly pipelineQueue: Queue<PipelineJobData>,
    private readonly auditLogService: AuditLogService,
    private readonly policyService: StoragePolicyService,
    private readonly efsService: EfsService,
    private readonly backupService: BackupService,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  async getRecommendation(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);
    return this.policyService.getPersistentStorageRecommendation(project.id);
  }

  async getStorage(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);
    return this.storageRepository.findOne({
      where: { projectId: project.id, environmentName: "dev" },
      order: { createdAt: "DESC" },
    });
  }

  async updateSettings(
    user: User,
    projectId: string,
    dto: { enabled?: boolean; backupEnabled?: boolean },
    req?: RequestInfo
  ) {
    const project = await this.findProjectForManage(user, projectId);
    const detection = await this.policyService.detectPersistentStorageNeed(project.id);
    const storage = await this.dataSource.transaction(async (manager) => {
      await acquireProjectConfigurationAdvisoryLock(manager, project.id, "production");
      const repository = manager.getRepository(ProjectPersistentStorage);
      const current = await this.persistStorageConfig(repository, project.id, {
        enabled: dto.enabled,
        backupEnabled: dto.backupEnabled,
      });
      current.requiredByDetection = detection.required;
      return repository.save(current);
    });
    await this.event(project.id, null, storage.id, "storage_settings_updated", "success", "Persistent storage settings updated.", user, {
      enabled: storage.enabled,
      backupEnabled: storage.backupEnabled,
      requiredByDetection: storage.requiredByDetection,
    });
    await this.audit("STORAGE_SETTINGS_UPDATED", project.id, user, "success", {
      storageId: storage.id,
      enabled: storage.enabled,
      backupEnabled: storage.backupEnabled,
      requiredByDetection: storage.requiredByDetection,
    }, req);

    return storage;
  }

  async provision(user: User, projectId: string, req?: RequestInfo) {
    const project = await this.findProjectForManage(user, projectId);
    let created: { storage: ProjectPersistentStorage; run: ProjectPipelineRun };
    created = await this.dataSource.transaction(async (manager) => {
      await acquireProjectConfigurationAdvisoryLock(manager, project.id, "production");
      const storageRepository = manager.getRepository(ProjectPersistentStorage);
      const runRepository = manager.getRepository(ProjectPipelineRun);
      const currentStorage = await this.persistStorageConfig(storageRepository, project.id, { enabled: true });
      if (!currentStorage.enabled) throw new BadRequestException("Persistent storage is disabled for this project.");
      const currentRun = await runRepository.save(runRepository.create({
        projectId: project.id,
        triggeredByUserId: user.id,
        repositoryUrl: project.repositoryUrl || "storage-provision",
        repositoryFullName: project.repositoryFullName || null,
        targetBranch: project.targetBranch || "main",
        status: PipelineRunStatus.QUEUED,
        currentStage: "storage_provision_queued",
        metadata: { jobType: "storage_provision" },
      }));
      currentStorage.pipelineRunId = currentRun.id;
      const savedStorage = await storageRepository.save(currentStorage);
      return { storage: savedStorage, run: currentRun };
    });
    const { storage, run } = created;
    await this.pipelineQueue.add(
      "storage_provision",
      {
        pipelineRunId: run.id,
        projectId: project.id,
        triggeredByUserId: user.id,
        jobType: "storage_provision",
        options: {
          triggerGithubActions: false,
          buildImage: false,
          pushToEcr: false,
          runTerraform: true,
        },
      },
      {
        attempts: Number(process.env.PIPELINE_JOB_ATTEMPTS || "1"),
        backoff: { type: "fixed", delay: 5000 },
      }
    );

    await this.event(project.id, run.id, storage.id, "efs_provisioning_queued", "queued", "EFS provisioning queued.", user);
    await this.audit("EFS_PROVISIONING_QUEUED", project.id, user, "success", {
      pipelineRunId: run.id,
      storageId: storage.id,
    }, req);

    return { pipelineRunId: run.id, persistentStorageId: storage.id };
  }

  private async persistStorageConfig(
    repository: Repository<ProjectPersistentStorage>,
    projectId: string,
    values: { enabled?: boolean; backupEnabled?: boolean },
  ) {
    const storageConfig = getStorageConfig(this.config);
    const existing = await repository.findOne({
      where: { projectId, environmentName: "dev" },
      order: { createdAt: "DESC" },
    });
    const storage = existing || repository.create({ projectId, environmentName: "dev" });
    storage.enabled = values.enabled ?? storage.enabled ?? false;
    storage.userEnabled = values.enabled ?? storage.userEnabled ?? false;
    storage.status = storage.enabled ? PersistentStorageStatus.PENDING : PersistentStorageStatus.NOT_REQUIRED;
    storage.awsRegion = storageConfig.awsRegion;
    storage.posixUid = storageConfig.posixUid;
    storage.posixGid = storageConfig.posixGid;
    storage.rootPermissions = storageConfig.rootPermissions;
    storage.rootDirectory = `${storageConfig.rootDirectoryBase.replace(/\/$/, "")}/${projectId}/dev`;
    storage.encrypted = true;
    storage.backupEnabled = values.backupEnabled ?? storageConfig.backupEnabled;
    storage.backupRetentionDays = storageConfig.backupRetentionDays;
    storage.metadata = { backupSchedule: storageConfig.backupSchedule };
    return repository.save(storage);
  }

  async getEvents(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);
    return this.eventRepository.find({
      where: { projectId: project.id },
      order: { createdAt: "ASC" },
    });
  }

  async getMountConfig(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);
    return this.efsService.getEfsMountInstructions(project.id);
  }

  async getBackups(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);
    return this.backupService.getBackupStatus(project.id);
  }

  async createRestoreRequest(
    user: User,
    projectId: string,
    dto: { persistentStorageId?: string; recoveryPointArn?: string; reason?: string },
    req?: RequestInfo
  ) {
    const project = await this.findProjectForManage(user, projectId);
    const storage = dto.persistentStorageId
      ? await this.storageRepository.findOne({ where: { id: dto.persistentStorageId, projectId: project.id } })
      : await this.storageRepository.findOne({
          where: { projectId: project.id, environmentName: "dev" },
          order: { createdAt: "DESC" },
        });

    if (!storage) {
      throw new NotFoundException("Persistent storage configuration not found.");
    }

    const request = await this.backupService.createRestoreRequest(
      project.id,
      storage.id,
      dto.recoveryPointArn || null,
      user.id,
      dto.reason || null
    );

    await this.event(project.id, storage.pipelineRunId || null, storage.id, "restore_request_created", "queued", "Storage restore request created.", user, {
      restoreRequestId: request.id,
    });
    await this.audit("STORAGE_RESTORE_REQUEST_CREATED", project.id, user, "success", {
      storageId: storage.id,
      restoreRequestId: request.id,
    }, req);

    return request;
  }

  async recordStorageEvent(
    projectId: string,
    pipelineRunId: string | null,
    eventType: string,
    status: string,
    message: string,
    actorUser?: User | null,
    metadata: Record<string, unknown> = {}
  ) {
    const storage = await this.storageRepository.findOne({
      where: { projectId, environmentName: "dev" },
      order: { createdAt: "DESC" },
    });

    return this.event(projectId, pipelineRunId, storage?.id || null, eventType, status, message, actorUser || null, metadata);
  }

  private async event(
    projectId: string,
    pipelineRunId: string | null,
    persistentStorageId: string | null,
    eventType: string,
    status: string,
    message: string,
    actorUser?: User | null,
    metadata: Record<string, unknown> = {}
  ) {
    return this.eventRepository.save(
      this.eventRepository.create({
        projectId,
        pipelineRunId,
        persistentStorageId,
        eventType,
        status,
        message,
        actorUserId: actorUser?.id || null,
        metadata: this.safeMetadata({
          projectId,
          pipelineRunId,
          persistentStorageId,
          eventType,
          status,
          ...metadata,
        }),
      })
    );
  }

  private async audit(
    action: string,
    projectId: string,
    actorUser: User,
    status: string,
    metadata: Record<string, unknown>,
    req?: RequestInfo
  ) {
    await this.auditLogService.record({
      actorUser,
      action,
      resourceType: "persistent_storage",
      resourceId: projectId,
      status,
      metadata: this.safeMetadata({ projectId, ...metadata }),
      req,
    });
  }

  private async findProjectForView(user: User, projectId: string) {
    const project = await this.projectRepository.findOne({ where: { id: projectId } });

    if (!project || project.status === ProjectStatus.ARCHIVED) {
      throw new NotFoundException("Project not found");
    }

    if (
      user.role === UserRole.ADMIN ||
      project.ownerUserId === user.id ||
      (user.role === UserRole.READONLY && project.visibility === ProjectVisibility.WORKSPACE)
    ) {
      return project;
    }

    throw new ForbiddenException("Insufficient permissions");
  }

  private async findProjectForManage(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);

    if (user.role === UserRole.READONLY) {
      throw new ForbiddenException("Insufficient permissions");
    }

    if (user.role === UserRole.ADMIN || project.ownerUserId === user.id) {
      return project;
    }

    throw new ForbiddenException("Insufficient permissions");
  }

  private safeMetadata(metadata: Record<string, unknown>) {
    const allowed = [
      "projectId",
      "pipelineRunId",
      "persistentStorageId",
      "storageId",
      "eventType",
      "status",
      "enabled",
      "backupEnabled",
      "requiredByDetection",
      "restoreRequestId",
      "efsFileSystemId",
      "efsAccessPointId",
      "backupPlanId",
      "backupVaultName",
      "reason",
    ];

    return Object.entries(metadata).reduce(
      (safe, [key, value]) => {
        if (allowed.includes(key) && value !== undefined) {
          safe[key] = value;
        }
        return safe;
      },
      {} as Record<string, unknown>
    );
  }
}
