import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { ProjectInfrastructureEnvironment } from "../infrastructure/project-infrastructure-environment.entity";
import { ProjectDetectionProfile } from "../projects/project-detection-profile.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { retiredMutationBoundaryProvider } from "../projects/pipeline/retired-mutation-boundary.provider";
import { Project } from "../projects/project.entity";
import { BackupService } from "./backup.service";
import { EfsService } from "./efs.service";
import { ProjectBackupRecord } from "./project-backup-record.entity";
import { ProjectPersistentStorage } from "./project-persistent-storage.entity";
import { ProjectStorageEvent } from "./project-storage-event.entity";
import { ProjectStorageRestoreRequest } from "./project-storage-restore-request.entity";
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
  providers: [
    retiredMutationBoundaryProvider,
    StorageService,
    StoragePolicyService,
    EfsService,
    BackupService,
  ],
  exports: [StorageService, StoragePolicyService, EfsService, BackupService],
})
export class StorageModule {}
