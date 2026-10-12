import { AdminAuthorizationModule } from "../admin/admin-authorization.module";
import { CustomerAuthorityService } from "./customer-authority.service";
import { CustomerAuthorityController } from "./customer-authority.controller";
import { HostingProfileRegistryService } from "../planning/hosting-profile-registry.service";
import { Module } from "@nestjs/common";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { WorkspacesController } from "./workspaces.controller";
import { WorkspacesService } from "./workspaces.service";
import { AwsAccountBindingsService } from "./aws-account-bindings.service";
import { CustomerAwsSessionService } from "../planning/customer-aws-session.service";
import { OrganizationLimitsModule } from "../billing/organization-limits.module";

@Module({ imports: [AuditLogModule, OrganizationLimitsModule, AdminAuthorizationModule], controllers: [WorkspacesController, CustomerAuthorityController], providers: [CustomerAuthorityService, WorkspacesService, AwsAccountBindingsService, CustomerAwsSessionService, HostingProfileRegistryService], exports: [WorkspacesService, AwsAccountBindingsService, CustomerAwsSessionService, HostingProfileRegistryService] })
export class WorkspacesModule {}
