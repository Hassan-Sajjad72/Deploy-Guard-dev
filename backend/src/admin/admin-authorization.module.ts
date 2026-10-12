import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { AdminAuthorizationService } from "./admin-authorization.service";

@Module({ imports: [AuthModule, AuditLogModule], providers: [AdminAuthorizationService], exports: [AdminAuthorizationService] })
export class AdminAuthorizationModule {}
