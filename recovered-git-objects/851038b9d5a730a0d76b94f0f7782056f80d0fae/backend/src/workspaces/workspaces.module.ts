import { Module } from "@nestjs/common";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { WorkspacesController } from "./workspaces.controller";
import { WorkspacesService } from "./workspaces.service";
import { AwsAccountBindingsService } from "./aws-account-bindings.service";
import { CustomerAwsSessionService } from "../planning/customer-aws-session.service";
import { OrganizationLimitsModule } from "../billing/organization-limits.module";

@Module({ imports: [AuditLogModule, OrganizationLimitsModule], controllers: [WorkspacesController], providers: [WorkspacesService, AwsAccountBindingsService, CustomerAwsSessionService], exports: [WorkspacesService, AwsAccountBindingsService, CustomerAwsSessionService] })
export class WorkspacesModule {}
