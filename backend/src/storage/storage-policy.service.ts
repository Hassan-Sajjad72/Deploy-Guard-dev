import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ProjectDetectionProfile } from "../projects/project-detection-profile.entity";
import { ProjectPersistentStorage } from "./project-persistent-storage.entity";
import { getStorageConfig } from "./storage.config";

@Injectable()
export class StoragePolicyService {
  constructor(
    @InjectRepository(ProjectDetectionProfile)
    private readonly profileRepository: Repository<ProjectDetectionProfile>,
    @InjectRepository(ProjectPersistentStorage)
    private readonly storageRepository: Repository<ProjectPersistentStorage>,
    private readonly config: ConfigService
  ) {}

  async detectPersistentStorageNeed(projectId: string) {
    const profile = await this.profileRepository.findOne({ where: { projectId } });
    const raw = JSON.stringify(profile?.rawProfile || {}).toLowerCase();
    const reasons: string[] = [];

    if (profile?.requiresPersistentStorage) reasons.push("Detection profile requires persistent storage.");
    if (profile?.requiresDatabase && /sqlite|file.?database/.test(raw)) reasons.push("SQLite or file database indicator detected.");
    if (/media_root|upload|uploads|media\//.test(raw)) reasons.push("Uploads/media storage indicator detected.");
    if (/django/.test((profile?.framework || "").toLowerCase()) && /media/.test(raw)) reasons.push("Django media storage indicator detected.");
    if (/flask/.test((profile?.framework || "").toLowerCase()) && /upload/.test(raw)) reasons.push("Flask upload folder indicator detected.");

    return {
      required: reasons.length > 0,
      reasons,
      profile,
    };
  }

  async getPersistentStorageRecommendation(projectId: string) {
    const detection = await this.detectPersistentStorageNeed(projectId);
    const storage = await this.storageRepository.findOne({
      where: { projectId, environmentName: "dev" },
      order: { createdAt: "DESC" },
    });

    return {
      required: detection.required,
      recommended: detection.required || Boolean(storage?.userEnabled),
      enabled: Boolean(storage?.enabled),
      reasons: detection.reasons.length > 0 ? detection.reasons : ["Persistent storage not required for the current detection profile."],
    };
  }

  async shouldProvisionEfs(projectId: string) {
    const config = getStorageConfig(this.config);
    const storage = await this.storageRepository.findOne({
      where: { projectId, environmentName: "dev" },
      order: { createdAt: "DESC" },
    });
    const detection = await this.detectPersistentStorageNeed(projectId);

    return config.enableEfs && (config.defaultEnabled || detection.required || Boolean(storage?.enabled));
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
