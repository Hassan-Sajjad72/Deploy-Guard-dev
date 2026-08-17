import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { UsersModule } from "../users/users.module";
import { AdminAuthController } from "./admin-auth.controller";

/**
 * AuthModule
 * ----------
 * Groups all auth-related things: controller, service.
 * Imports UsersModule so AuthService can use UsersService.
 */
@Module({
  imports: [UsersModule, AuditLogModule],
  controllers: [AuthController, AdminAuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
