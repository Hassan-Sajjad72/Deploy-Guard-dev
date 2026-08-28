import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { ProjectCostEstimate } from "../finops/project-cost-estimate.entity";
import { ProjectInfrastructureEnvironment } from "../infrastructure/project-infrastructure-environment.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { Project } from "../projects/project.entity";
import { ProjectTerraformState } from "../state-management/project-terraform-state.entity";
import { ProjectPersistentStorage } from "../storage/project-persistent-storage.entity";
import { AlbService } from "./alb.service";
import { AutoscalingService } from "./autoscaling.service";
import { OrchestrationDeploymentReadinessService } from "./deployment-readiness.service";
import { EcsService } from "./ecs.service";
import { OrchestrationService } from "./orchestration.service";
import { ProjectDeployment } from "./project-deployment.entity";
import { ProjectOrchestrationEvent } from "./project-orchestration-event.entity";
import { ProjectRollbackRecord } from "./project-rollback-record.entity";
import { ProjectSpotInterruptionEvent } from "./project-spot-interruption-event.entity";
import { ProjectStableRelease } from "./project-stable-release.entity";
import { SpotInterruptionService } from "./spot-interruption.service";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Project,
      ProjectPipelineRun,
      ProjectCostEstimate,
      ProjectInfrastructureEnvironment,
      ProjectTerraformState,
      ProjectPersistentStorage,
      ProjectDeployment,
      ProjectStableRelease,
      ProjectOrchestrationEvent,
      ProjectSpotInterruptionEvent,
      ProjectRollbackRecord,
    ]),
    AuditLogModule,
    NotificationsModule,
  ],
  providers: [
    OrchestrationService,
    EcsService,
    AlbService,
    AutoscalingService,
    SpotInterruptionService,
    OrchestrationDeploymentReadinessService,
  ],
  exports: [
    OrchestrationService,
    EcsService,
    AlbService,
    AutoscalingService,
    SpotInterruptionService,
  ],
})
export class OrchestrationModule {}
