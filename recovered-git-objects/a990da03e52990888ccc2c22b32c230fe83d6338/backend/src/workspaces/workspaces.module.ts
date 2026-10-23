import { Module } from "@nestjs/common";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { WorkspacesController } from "./workspaces.controller";
import { WorkspacesService } from "./workspaces.service";
import { AwsAccountBindingsService } from "./aws-account-bindings.service";

@Module({ imports: [AuditLogModule], controllers: [WorkspacesController], providers: [WorkspacesService, AwsAccountBindingsService], exports: [WorkspacesService, AwsAccountBindingsService] })
export class WorkspacesModule {}
