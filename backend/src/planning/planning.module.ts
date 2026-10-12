import { AwsPublicPricingService } from "./aws-public-pricing.service";
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
import { UsersModule } from "../users/users.module";
import { BillingModule } from "../billing/billing.module";
import { HostingProviderAdapterService } from "./hosting-provider-adapter.service";
import { HostingProviderSessionService } from "./hosting-provider-session.service";
import { HostingBuildService } from "./hosting-build.service";

@Module({ imports: [ProjectsModule, AuditLogModule, AiTroubleshootingModule, WorkspacesModule, UsersModule, BillingModule], controllers: [PlanningController], providers: [AwsPublicPricingService, PlanningService, HostingPricingService, InfracostService, HostingProviderSessionService, HostingProviderAdapterService, HostingBuildService], exports: [WorkspacesModule, HostingProviderAdapterService] })
export class PlanningModule {}
