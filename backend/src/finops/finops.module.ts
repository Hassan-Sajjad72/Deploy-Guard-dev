import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { ProjectPipelineEvent } from "../projects/project-pipeline-event.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { ProjectDatabaseTier } from "../projects/project-database-tier.entity";
import { Project } from "../projects/project.entity";
import { retiredMutationBoundaryProvider } from "../projects/pipeline/retired-mutation-boundary.provider";
import { ProjectPersistentStorage } from "../storage/project-persistent-storage.entity";
import { FinopsController } from "./finops.controller";
import { FinopsPolicyService } from "./finops-policy.service";
import { FinopsService } from "./finops.service";
import { InfracostService } from "./infracost.service";
import { ProjectCostEstimate } from "./project-cost-estimate.entity";
import { ProjectCostResourceBreakdown } from "./project-cost-resource-breakdown.entity";
import { ProjectCostSettings } from "./project-cost-settings.entity";
import { TerraformCostPlanService } from "./terraform-cost-plan.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Project,
      ProjectDatabaseTier,
      ProjectPipelineRun,
      ProjectPipelineEvent,
      ProjectCostEstimate,
      ProjectCostResourceBreakdown,
      ProjectCostSettings,
      ProjectPersistentStorage,
    ]),
    AuditLogModule,
  ],
  controllers: [FinopsController],
  providers: [
    FinopsService,
    FinopsPolicyService,
    InfracostService,
    TerraformCostPlanService,
    retiredMutationBoundaryProvider,
  ],
  exports: [FinopsService],
})
export class FinopsModule {}
