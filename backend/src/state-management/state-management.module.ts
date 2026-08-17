import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { ProjectInfrastructureEnvironment } from "../infrastructure/project-infrastructure-environment.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { PipelineActivityService } from "../projects/pipeline/pipeline-activity.service";
import { retiredMutationBoundaryProvider } from "../projects/pipeline/retired-mutation-boundary.provider";
import { Project } from "../projects/project.entity";
import { AwsCliModule } from "./aws-cli.module";
import { CurrentStateInvalidationService } from "./current-state-invalidation.service";
import { OrphanedLockMonitorService } from "./orphaned-lock-monitor.service";
import { ProjectDeploymentQueueItem } from "./project-deployment-queue-item.entity";
import { ProjectStateRecoveryRequest } from "./project-state-recovery-request.entity";
import { ProjectStateValidationResult } from "./project-state-validation-result.entity";
import { ProjectTerraformLock } from "./project-terraform-lock.entity";
import { ProjectTerraformState } from "./project-terraform-state.entity";
import { StateCorruptionService } from "./state-corruption.service";
import { StateHeartbeatService } from "./state-heartbeat.service";
import { StateLockService } from "./state-lock.service";
import { StateManagementService } from "./state-management.service";
import { StateRecoveryService } from "./state-recovery.service";
import { TerraformStateService } from "./terraform-state.service";
import { TerraformStateSafetySnapshotService } from "./terraform-state-safety-snapshot.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Project,
      ProjectPipelineRun,
      ProjectInfrastructureEnvironment,
      ProjectTerraformState,
      ProjectTerraformLock,
      ProjectDeploymentQueueItem,
      ProjectStateValidationResult,
      ProjectStateRecoveryRequest,
    ]),
    AuditLogModule,
    AwsCliModule,
  ],
  providers: [
    retiredMutationBoundaryProvider,
    PipelineActivityService,
    CurrentStateInvalidationService,
    TerraformStateSafetySnapshotService,
    TerraformStateService,
    StateLockService,
    StateHeartbeatService,
    OrphanedLockMonitorService,
    StateCorruptionService,
    StateRecoveryService,
    StateManagementService,
  ],
  exports: [
    AwsCliModule,
    TerraformStateService,
    StateLockService,
    StateHeartbeatService,
    OrphanedLockMonitorService,
    StateCorruptionService,
    StateRecoveryService,
    CurrentStateInvalidationService,
    TerraformStateSafetySnapshotService,
  ],
})
export class StateManagementModule {}
