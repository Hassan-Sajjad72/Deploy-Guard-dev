import { Module } from "@nestjs/common";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { ProjectsModule } from "../projects/projects.module";
import { UsersModule } from "../users/users.module";
import { AdminController } from "./admin.controller";
import { AdminAuthorizationModule } from "./admin-authorization.module";

@Module({
  imports: [UsersModule, AuditLogModule, ProjectsModule, AdminAuthorizationModule],
  controllers: [AdminController],
})
export class AdminModule {}
