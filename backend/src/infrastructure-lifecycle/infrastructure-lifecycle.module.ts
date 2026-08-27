import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { ProjectInfrastructureEnvironment } from "../infrastructure/project-infrastructure-environment.entity";
import { ProjectDeployment } from "../orchestration/project-deployment.entity";
import { ProjectStableRelease } from "../orchestration/project-stable-release.entity";
import { ProjectPipelineEvent } from "../projects/project-pipeline-event.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { PipelineActivityService } from "../projects/pipeline/pipeline-activity.service";
import { Project } from "../projects/project.entity";
import { ResourceRegistryModule } from "../resource-registry/resource-registry.module";
import { StateManagementModule } from "../state-management/state-management.module";
import { ProjectTerraformState } from "../state-management/project-terraform-state.entity";
import { CentralCloudResource } from "./central-cloud-resource.entity";
import { CloudInventoryScan } from "./cloud-inventory-scan.entity";
import { CloudStateReconciliationService } from "./cloud-state-reconciliation.service";
import { DestroyOperation } from "./destroy-operation.entity";
import { ProjectCloudInventoryService } from "./project-cloud-inventory.service";
import { ProjectCloudState } from "./project-cloud-state.entity";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Project,
      ProjectPipelineRun,
      ProjectPipelineEvent,
      ProjectInfrastructureEnvironment,
      ProjectTerraformState,
      ProjectDeployment,
      ProjectStableRelease,
      ProjectCloudState,
      DestroyOperation,
      CentralCloudResource,
      CloudInventoryScan,
    ]),
    AuditLogModule,
    StateManagementModule,
    ResourceRegistryModule,
  ],
  providers: [PipelineActivityService, ProjectCloudInventoryService, CloudStateReconciliationService],
  exports: [ProjectCloudInventoryService, CloudStateReconciliationService],
})
export class InfrastructureLifecycleModule {}
