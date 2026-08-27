import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ProjectBackupRecord, BackupRecordStatus } from "./project-backup-record.entity";
import { ProjectPersistentStorage } from "./project-persistent-storage.entity";
import { ProjectStorageRestoreRequest } from "./project-storage-restore-request.entity";

@Injectable()
export class BackupService {
  constructor(
    @InjectRepository(ProjectBackupRecord)
    private readonly backupRepository: Repository<ProjectBackupRecord>,
    @InjectRepository(ProjectStorageRestoreRequest)
    private readonly restoreRepository: Repository<ProjectStorageRestoreRequest>
  ) {}

  async configureBackupPlan(storage: ProjectPersistentStorage) {
    if (!storage.backupEnabled || !storage.backupVaultName) {
      return null;
    }

    const existing = await this.backupRepository.findOne({
      where: { projectId: storage.projectId, persistentStorageId: storage.id },
    });
    const record = existing || this.backupRepository.create({
      projectId: storage.projectId,
      persistentStorageId: storage.id,
    });

    record.backupVaultName = storage.backupVaultName;
    record.backupPlanId = storage.backupPlanId;
    record.status = BackupRecordStatus.CONFIGURED;
    record.retentionDays = storage.backupRetentionDays;
    record.schedule = storage.metadata?.backupSchedule ? String(storage.metadata.backupSchedule) : null;

    return this.backupRepository.save(record);
  }

  async getBackupStatus(projectId: string) {
    return this.backupRepository.find({
      where: { projectId },
      order: { createdAt: "DESC" },
    });
  }

  async listBackupRecoveryPoints(projectId: string) {
    return this.getBackupStatus(projectId);
  }

  async createRestoreRequest(
    projectId: string,
    persistentStorageId: string,
    recoveryPointArn: string | null,
    requestedByUserId?: number | null,
    reason?: string | null
  ) {
    return this.restoreRepository.save(
      this.restoreRepository.create({
        projectId,
        persistentStorageId,
        recoveryPointArn,
        requestedByUserId: requestedByUserId || null,
        reason: reason || "Restore request created. Actual AWS restore is reserved for a later workflow.",
      })
    );
  }

  async markBackupProtected(storage: ProjectPersistentStorage) {
    return this.configureBackupPlan(storage);
  }
}
