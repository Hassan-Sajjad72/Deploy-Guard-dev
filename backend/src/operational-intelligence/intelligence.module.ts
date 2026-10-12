import { Module } from "@nestjs/common";
import { UsersModule } from "../users/users.module";
import { ProjectsModule } from "../projects/projects.module";
import { ObservabilityModule } from "../observability/observability.module";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { AdminAuthorizationModule } from "../admin/admin-authorization.module";
import { CustomerSupportAccessController, IntelligenceController } from "./intelligence.controller";
import { IntelligenceService } from "./intelligence.service";
import { PlanningModule } from "../planning/planning.module";

@Module({ imports: [UsersModule, ProjectsModule, ObservabilityModule, AuditLogModule, AdminAuthorizationModule, PlanningModule], controllers: [IntelligenceController, CustomerSupportAccessController], providers: [IntelligenceService], exports: [IntelligenceService] })
export class IntelligenceModule {}
