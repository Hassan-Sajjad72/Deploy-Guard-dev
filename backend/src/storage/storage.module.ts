import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { ProjectInfrastructureEnvironment } from "../infrastructure/project-infrastructure-environment.entity";
import { ProjectDetectionProfile } from "../projects/project-detection-profile.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { pipelineQueueProvider } from "../projects/pipeline/pipeline.queue";
import { Project } from "../projects/project.entity";
import { BackupService } from "./backup.service";
import { EfsService } from "./efs.service";
import { ProjectBackupRecord } from "./project-backup-record.entity";
import { ProjectPersistentStorage } from "./project-persistent-storage.entity";
import { ProjectStorageEvent } from "./project-storage-event.entity";
import { ProjectStorageRestoreRequest } from "./project-storage-restore-request.entity";
import { StorageController } from "./storage.controller";
import { StoragePolicyService } from "./storage-policy.service";
import { StorageService } from "./storage.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Project,
      ProjectDetectionProfile,
      ProjectPipelineRun,
      ProjectInfrastructureEnvironment,
      ProjectPersistentStorage,
      ProjectStorageEvent,
      ProjectBackupRecord,
      ProjectStorageRestoreRequest,
    ]),
    AuditLogModule,
  ],
  controllers: [StorageController],
  providers: [
    pipelineQueueProvider,
    StorageService,
    StoragePolicyService,
    EfsService,
    BackupService,
  ],
  exports: [StorageService, StoragePolicyService, EfsService, BackupService],
})
export class StorageModule {}
