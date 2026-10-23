import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { ProjectCostEstimate } from "../finops/project-cost-estimate.entity";
import { ProjectDeploymentContract } from "../projects/project-deployment-contract.entity";
import { ProjectDatabaseTier } from "../projects/project-database-tier.entity";
import { ProjectEnvironmentVariable } from "../projects/project-environment-variable.entity";
import { ProjectPipelineEvent } from "../projects/project-pipeline-event.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { ProjectPreflightReport } from "../projects/project-preflight-report.entity";
import { ProjectSecurityScan } from "../projects/project-security-scan.entity";
import { pipelineQueueProvider } from "../projects/pipeline/pipeline.queue";
import { PipelineActivityService } from "../projects/pipeline/pipeline-activity.service";
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
import { ProjectEnvironmentCryptoService } from "../projects/project-environment-crypto.service";
import { ProjectServiceBinding } from "../projects/project-service-binding.entity";
import { ProjectConfigurationSnapshot } from "../projects/project-configuration-snapshot.entity";
import { ProjectDetectionProfile } from "../projects/project-detection-profile.entity";
import { DatabaseServiceBindingService } from "./database-service-binding.service";
import { ResourceRegistryModule } from "../resource-registry/resource-registry.module";
import { ProjectPersistentStorage } from "../storage/project-persistent-storage.entity";
import { TerraformApprovalStateService } from "./terraform-approval-state.service";
import { DeploymentContractValidationService } from "./deployment-contract-validation.service";
import { OrchestrationContractsModule } from "../orchestration-contracts/orchestration-contracts.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Project,
      ProjectEnvironmentVariable,
      ProjectDeploymentContract,
      ProjectDatabaseTier,
      ProjectPreflightReport,
      ProjectPipelineRun,
      ProjectPipelineEvent,
      ProjectSecurityScan,
      ProjectCostEstimate,
      ProjectInfrastructureEnvironment,
      ProjectInfrastructureEvent,
      ProjectServiceDiscoveryRecord,
      ProjectDeploymentReadinessSnapshot,
      ProjectServiceBinding,
      ProjectConfigurationSnapshot,
      ProjectDetectionProfile,
      ProjectPersistentStorage,
    ]),
    AuditLogModule,
    StateManagementModule,
    StorageModule,
    ResourceRegistryModule,
    OrchestrationContractsModule,
  ],
  controllers: [InfrastructureController],
  providers: [
    pipelineQueueProvider,
    PipelineActivityService,
    InfrastructureService,
    InfrastructureReadinessService,
    TerraformRunnerService,
    ServiceDiscoveryService,
    ProjectEnvironmentCryptoService,
    DatabaseServiceBindingService,
    DeploymentContractValidationService,
    TerraformApprovalStateService,
  ],
  exports: [InfrastructureService, InfrastructureReadinessService, DatabaseServiceBindingService, TerraformApprovalStateService],
})
export class InfrastructureModule {}
