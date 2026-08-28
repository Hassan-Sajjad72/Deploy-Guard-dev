import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ProjectPersistentStorage } from "./project-persistent-storage.entity";
import { getStorageConfig } from "./storage.config";

@Injectable()
export class StoragePolicyService {
  constructor(
    @InjectRepository(ProjectPersistentStorage)
    private readonly storageRepository: Repository<ProjectPersistentStorage>,
    private readonly config: ConfigService
  ) {}

  async getPersistentStorageRecommendation(projectId: string) {
    const storage = await this.storageRepository.findOne({
      where: { projectId, environmentName: "dev" },
      order: { createdAt: "DESC" },
    });

    return {
      required: Boolean(storage?.enabled),
      recommended: Boolean(storage?.userEnabled || storage?.enabled),
      enabled: Boolean(storage?.enabled),
      reasons: storage?.enabled ? ["Persistent storage is explicitly enabled for this project."] : ["Persistent storage is not enabled for this project."],
    };
  }

  async shouldProvisionEfs(projectId: string) {
    const config = getStorageConfig(this.config);
    const storage = await this.storageRepository.findOne({
      where: { projectId, environmentName: "dev" },
      order: { createdAt: "DESC" },
    });
    return config.enableEfs && (config.defaultEnabled || Boolean(storage?.enabled));
  }

  async buildEfsTerraformVariables(projectId: string, environmentName = "dev") {
    const config = getStorageConfig(this.config);
    const enableEfs = await this.shouldProvisionEfs(projectId);

    return {
      enable_efs: enableEfs,
      efs_performance_mode: config.performanceMode,
      efs_throughput_mode: config.throughputMode,
      efs_transition_to_ia: config.transitionToIa,
      efs_posix_uid: config.posixUid,
      efs_posix_gid: config.posixGid,
      efs_root_permissions: config.rootPermissions,
      efs_root_directory: `${config.rootDirectoryBase.replace(/\/$/, "")}/${projectId}/${environmentName}`,
      enable_efs_backup: config.backupEnabled,
      efs_backup_retention_days: config.backupRetentionDays,
      efs_backup_schedule: config.backupSchedule,
    };
  }
}
