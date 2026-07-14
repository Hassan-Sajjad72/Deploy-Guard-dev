import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ProjectInfrastructureEnvironment } from "../infrastructure/project-infrastructure-environment.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { ProjectPersistentStorage, PersistentStorageStatus } from "./project-persistent-storage.entity";
import { getStorageConfig } from "./storage.config";
import { BackupService } from "./backup.service";

@Injectable()
export class EfsService {
  constructor(
    @InjectRepository(ProjectPersistentStorage)
    private readonly storageRepository: Repository<ProjectPersistentStorage>,
    @InjectRepository(ProjectInfrastructureEnvironment)
    private readonly environmentRepository: Repository<ProjectInfrastructureEnvironment>,
    private readonly config: ConfigService,
    private readonly backupService: BackupService
  ) {}

  async createOrUpdateEfsConfig(projectId: string, config: { enabled?: boolean; backupEnabled?: boolean }) {
    const storageConfig = getStorageConfig(this.config);
    const existing = await this.storageRepository.findOne({
      where: { projectId, environmentName: "dev" },
      order: { createdAt: "DESC" },
    });
    const storage = existing || this.storageRepository.create({ projectId, environmentName: "dev" });

    storage.enabled = config.enabled ?? storage.enabled ?? false;
    storage.userEnabled = config.enabled ?? storage.userEnabled ?? false;
    storage.status = storage.enabled ? PersistentStorageStatus.PENDING : PersistentStorageStatus.NOT_REQUIRED;
    storage.awsRegion = storageConfig.awsRegion;
    storage.posixUid = storageConfig.posixUid;
    storage.posixGid = storageConfig.posixGid;
    storage.rootPermissions = storageConfig.rootPermissions;
    storage.rootDirectory = `${storageConfig.rootDirectoryBase.replace(/\/$/, "")}/${projectId}/dev`;
    storage.encrypted = true;
    storage.backupEnabled = config.backupEnabled ?? storageConfig.backupEnabled;
    storage.backupRetentionDays = storageConfig.backupRetentionDays;
    storage.metadata = { backupSchedule: storageConfig.backupSchedule };

    return this.storageRepository.save(storage);
  }

  async provisionEfs(projectId: string, pipelineRunId: string) {
    const storage = await this.createOrUpdateEfsConfig(projectId, { enabled: true });
    storage.pipelineRunId = pipelineRunId;
    storage.status = PersistentStorageStatus.PROVISIONING;
    return this.storageRepository.save(storage);
  }

  parseEfsTerraformOutputs(outputs: Record<string, unknown>) {
    return {
      enabled: Boolean(outputs.efs_enabled),
      efsFileSystemId: this.stringOutput(outputs.efs_file_system_id),
      efsFileSystemArn: this.stringOutput(outputs.efs_file_system_arn),
      efsDnsName: this.stringOutput(outputs.efs_dns_name),
      efsAccessPointId: this.stringOutput(outputs.efs_access_point_id),
      efsAccessPointArn: this.stringOutput(outputs.efs_access_point_arn),
      efsSecurityGroupId: this.stringOutput(outputs.efs_security_group_id),
      kmsKeyId: this.stringOutput(outputs.efs_kms_key_id),
      kmsKeyArn: this.stringOutput(outputs.efs_kms_key_arn),
      mountTargetIds: Array.isArray(outputs.efs_mount_target_ids) ? outputs.efs_mount_target_ids.map(String) : [],
      rootDirectory: this.stringOutput(outputs.efs_root_directory),
      posixUid: Number(outputs.efs_posix_uid || 1000),
      posixGid: Number(outputs.efs_posix_gid || 1000),
      rootPermissions: this.stringOutput(outputs.efs_root_permissions) || "750",
      backupVaultName: this.stringOutput(outputs.efs_backup_vault_name),
      backupPlanId: this.stringOutput(outputs.efs_backup_plan_id),
      backupEnabled: Boolean(outputs.efs_backup_enabled),
    };
  }

  async saveEfsOutputs(projectId: string, pipelineRunId: string, outputs: Record<string, unknown>) {
    const parsed = this.parseEfsTerraformOutputs(outputs);
    const storage = await this.createOrUpdateEfsConfig(projectId, { enabled: parsed.enabled, backupEnabled: parsed.backupEnabled });
    const environment = await this.environmentRepository.findOne({ where: { projectId }, order: { createdAt: "DESC" } });

    storage.pipelineRunId = pipelineRunId;
    storage.infrastructureEnvironmentId = environment?.id || storage.infrastructureEnvironmentId || null;
    storage.enabled = parsed.enabled;
    storage.status = parsed.enabled ? PersistentStorageStatus.PROVISIONED : PersistentStorageStatus.NOT_REQUIRED;
    storage.efsFileSystemId = parsed.efsFileSystemId;
    storage.efsFileSystemArn = parsed.efsFileSystemArn;
    storage.efsDnsName = parsed.efsDnsName;
    storage.efsAccessPointId = parsed.efsAccessPointId;
    storage.efsAccessPointArn = parsed.efsAccessPointArn;
    storage.efsSecurityGroupId = parsed.efsSecurityGroupId;
    storage.kmsKeyId = parsed.kmsKeyId;
    storage.kmsKeyArn = parsed.kmsKeyArn;
    storage.mountTargetIds = parsed.mountTargetIds;
    storage.rootDirectory = parsed.rootDirectory || storage.rootDirectory;
    storage.posixUid = parsed.posixUid;
    storage.posixGid = parsed.posixGid;
    storage.rootPermissions = parsed.rootPermissions;
    storage.encrypted = parsed.enabled;
    storage.backupEnabled = parsed.backupEnabled;
    storage.backupVaultName = parsed.backupVaultName;
    storage.backupPlanId = parsed.backupPlanId;
    storage.ecsMountConfig = this.getEfsEcsMountConfigFromStorage(storage);
    storage.provisionedAt = parsed.enabled ? new Date() : null;

    const saved = await this.storageRepository.save(storage);
    await this.backupService.markBackupProtected(saved);
    return saved;
  }

  async getEfsStatus(projectId: string) {
    return this.storageRepository.findOne({
      where: { projectId, environmentName: "dev" },
      order: { createdAt: "DESC" },
    });
  }

  async getEfsMountInstructions(projectId: string) {
    const storage = await this.getEfsStatus(projectId);
    return storage ? this.getEfsEcsMountConfigFromStorage(storage) : null;
  }

  getEfsEcsMountConfig(projectId: string) {
    return this.getEfsMountInstructions(projectId);
  }

  getEfsEcsMountConfigFromStorage(storage: ProjectPersistentStorage) {
    if (!storage.efsFileSystemId || !storage.efsAccessPointId) {
      return null;
    }

    return {
      volumes: [
        {
          name: "persistent-storage",
          efsVolumeConfiguration: {
            fileSystemId: storage.efsFileSystemId,
            transitEncryption: "ENABLED",
            authorizationConfig: {
              accessPointId: storage.efsAccessPointId,
              iam: "ENABLED",
            },
          },
        },
      ],
      mountPoints: [
        {
          sourceVolume: "persistent-storage",
          containerPath: "/app/data",
          readOnly: false,
        },
      ],
    };
  }

  private stringOutput(value: unknown) {
    return value === undefined || value === null ? null : String(value);
  }
}
