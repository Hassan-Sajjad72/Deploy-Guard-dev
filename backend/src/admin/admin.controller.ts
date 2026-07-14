import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Request } from "express";
import { AuditLogService } from "../audit-log/audit-log.service";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";
import { UsersService } from "../users/users.service";
import { UpdateUserRoleDto } from "./dto/update-user-role.dto";

@Controller("api/admin")
export class AdminController {
  constructor(
    private readonly usersService: UsersService,
    private readonly auditLogService: AuditLogService
  ) {}

  @Get("users")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async listUsers(@Req() req: Request) {
    const users = await this.usersService.findAll();

    await this.auditLogService.record({
      actorUser: req.user,
      action: "USER_LIST_VIEWED",
      resourceType: "user",
      status: "success",
      req,
    });

    return {
      users: users.map((user) => ({
        id: String(user.id),
        email: user.email,
        name: user.name,
        role: user.role,
        provider: user.githubId ? "github" : null,
        createdAt: user.createdAt,
      })),
    };
  }

  @Patch("users/:userId/role")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async updateUserRole(
    @Param("userId", ParseIntPipe) userId: number,
    @Body() dto: UpdateUserRoleDto,
    @Req() req: Request
  ) {
    const updatedUser = await this.usersService.updateRole(
      userId,
      dto.role,
      req.user?.id
    );

    await this.auditLogService.record({
      actorUser: req.user,
      action: "USER_ROLE_UPDATED",
      resourceType: "user",
      resourceId: String(updatedUser.id),
      status: "success",
      metadata: {
        newRole: updatedUser.role,
      },
      req,
    });

    return {
      user: {
        id: String(updatedUser.id),
        email: updatedUser.email,
        name: updatedUser.name,
        role: updatedUser.role,
        provider: updatedUser.githubId ? "github" : null,
        createdAt: updatedUser.createdAt,
      },
    };
  }
}
