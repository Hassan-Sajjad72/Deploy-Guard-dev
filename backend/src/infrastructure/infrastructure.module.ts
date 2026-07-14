import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { ProjectCostEstimate } from "../finops/project-cost-estimate.entity";
import { ProjectDetectionProfile } from "../projects/project-detection-profile.entity";
import { ProjectEnvironmentVariable } from "../projects/project-environment-variable.entity";
import { ProjectPipelineEvent } from "../projects/project-pipeline-event.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { ProjectPreflightReport } from "../projects/project-preflight-report.entity";
import { ProjectSecurityScan } from "../projects/project-security-scan.entity";
import { pipelineQueueProvider } from "../projects/pipeline/pipeline.queue";
import { Project } from "../projects/project.entity";
import { StateManagementModule } from "../state-management/state-management.module";
import { StorageModule } from "../storage/storage.module";
import { InfrastructureController } from "./infrastructure.controller";
import { InfrastructureReadinessService } from "./infrastructure-readiness.service";
import { InfrastructureService } from "./infrastructure.service";
import { ProjectDeploymentReadinessSnapshot } from "./project-deployment-readiness-snapshot.entity";
import { ProjectInfrastructureEnvironment } from "./project-infrastructure-environment.entity";
import { ProjectInfrastructureEvent } from "./project-infrastructure-event.entity";
import { ProjectServiceDiscoveryRecord } from "./project-service-discovery-record.entity";
import { ServiceDiscoveryService } from "./service-discovery.service";
import { TerraformRunnerService } from "./terraform-runner.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Project,
      ProjectEnvironmentVariable,
      ProjectDetectionProfile,
      ProjectPreflightReport,
      ProjectPipelineRun,
      ProjectPipelineEvent,
      ProjectSecurityScan,
      ProjectCostEstimate,
      ProjectInfrastructureEnvironment,
      ProjectInfrastructureEvent,
      ProjectServiceDiscoveryRecord,
      ProjectDeploymentReadinessSnapshot,
    ]),
    AuditLogModule,
    StateManagementModule,
    StorageModule,
  ],
  controllers: [InfrastructureController],
  providers: [
    pipelineQueueProvider,
    InfrastructureService,
    InfrastructureReadinessService,
    TerraformRunnerService,
    ServiceDiscoveryService,
  ],
  exports: [InfrastructureService, InfrastructureReadinessService],
})
export class InfrastructureModule {}
