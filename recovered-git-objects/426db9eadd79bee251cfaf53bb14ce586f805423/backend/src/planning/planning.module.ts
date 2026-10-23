import { Module } from "@nestjs/common";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { ProjectsModule } from "../projects/projects.module";
import { AiTroubleshootingModule } from "../ai-troubleshooting/ai-troubleshooting.module";
import { PlanningController } from "./planning.controller";
import { PlanningService } from "./planning.service";
import { HostingPricingService } from "./hosting-pricing.service";
import { InfracostService } from "../finops/infracost.service";
import { CustomerAwsSessionService } from "./customer-aws-session.service";
import { WorkspacesModule } from "../workspaces/workspaces.module";

@Module({ imports: [ProjectsModule, AuditLogModule, AiTroubleshootingModule, WorkspacesModule], controllers: [PlanningController], providers: [PlanningService, HostingPricingService, InfracostService], exports: [WorkspacesModule] })
export class PlanningModule {}
