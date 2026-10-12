import { Module } from "@nestjs/common";
import { AdminAuthorizationModule } from "../admin/admin-authorization.module";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { OrganizationLimitsService } from "./organization-limits.service";
import { AdminOrganizationLimitsController, OrganizationLimitsController } from "./organization-limits.controller";
@Module({ imports: [AdminAuthorizationModule,AuditLogModule], providers: [OrganizationLimitsService], controllers: [AdminOrganizationLimitsController,OrganizationLimitsController], exports: [OrganizationLimitsService] })
export class OrganizationLimitsModule {}
