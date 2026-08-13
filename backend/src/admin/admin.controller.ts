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
import { ConfigService } from "@nestjs/config";
import { Request } from "express";
import { DataSource } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";
import { UsersService } from "../users/users.service";
import { UpdateUserRoleDto } from "./dto/update-user-role.dto";
import { UpdateUserAccessDto } from "./dto/update-user-access.dto";

@Controller("api/admin")
export class AdminController {
  constructor(
    private readonly usersService: UsersService,
    private readonly auditLogService: AuditLogService,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource
  ) {}

  @Get("overview")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async overview(@Req() req: Request) {
    let database = false;
    let projects = 0;
    let activeOperations = 0;
    let failedOperations = 0;
    let destroyingOperations = 0;
    try {
      await this.dataSource.query("SELECT 1");
      database = true;
      const [projectRows, operationRows] = await Promise.all([
        this.dataSource.query(`SELECT COUNT(*)::int AS count FROM "projects" WHERE "status" != 'archived'`),
        this.dataSource.query(`SELECT
          COUNT(*) FILTER (WHERE "status" IN ('queued', 'running'))::int AS active,
          COUNT(*) FILTER (WHERE "status" = 'failed')::int AS failed,
          COUNT(*) FILTER (WHERE "status" IN ('queued', 'running') AND "metadata" ->> 'deploymentAction' = 'destroy')::int AS destroying
          FROM "project_pipeline_runs" WHERE "metadata" ->> 'executionEngine' = 'github_actions'`),
      ]);
      projects = Number(projectRows[0]?.count || 0);
      activeOperations = Number(operationRows[0]?.active || 0);
      failedOperations = Number(operationRows[0]?.failed || 0);
      destroyingOperations = Number(operationRows[0]?.destroying || 0);
    } catch {
      database = false;
    }
    const configured = (names: string[]) => names.every((name) => Boolean(this.config.get<string>(name)?.trim()));
    const result = {
      generatedAt: new Date().toISOString(),
      services: {
        backend: { status: "available", source: "live_api" },
        database: { status: database ? "available" : "unavailable", source: "postgresql_probe" },
        githubOAuth: { status: configured(["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]) ? "configured" : "unavailable", source: "runtime_configuration" },
        githubApp: { status: configured(["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"]) ? "configured" : "unavailable", source: "runtime_configuration" },
        githubActions: { status: configured(["DEPLOYGUARD_REUSABLE_WORKFLOW", "DEPLOYGUARD_GITHUB_ACTIONS_ROLE_ARN"]) ? "configured" : "unavailable", source: "runtime_configuration" },
        awsOidc: { status: configured(["DEPLOYGUARD_GITHUB_ACTIONS_ROLE_ARN"]) ? "configured" : "unavailable", source: "runtime_configuration" },
        terraformState: { status: configured(["DEPLOYGUARD_TERRAFORM_STATE_BUCKET"]) ? "configured" : "unavailable", source: "runtime_configuration" },
        prometheus: { status: this.config.get<string>("PROMETHEUS_ENABLED") === "true" ? "configured" : "disabled", source: "runtime_configuration" },
        grafana: { status: configured(["GRAFANA_URL"]) ? "configured" : "unavailable", source: "runtime_configuration" },
      },
      counts: { projects, activeOperations, failedOperations, destroyingOperations },
    };
    await this.auditLogService.record({ actorUser: req.user, action: "ADMIN_OVERVIEW_VIEWED", resourceType: "platform", status: "success", req });
    return result;
  }

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
        githubLogin: user.githubLogin,
        enabled: !user.disabledAt,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
      })),
    };
  }

  @Patch("users/:userId/access")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async updateUserAccess(
    @Param("userId", ParseIntPipe) userId: number,
    @Body() dto: UpdateUserAccessDto,
    @Req() req: Request
  ) {
    const updatedUser = await this.usersService.updateAccess(userId, dto.enabled, req.user?.id);
    await this.auditLogService.record({
      actorUser: req.user,
      action: dto.enabled ? "USER_ENABLED" : "USER_DISABLED",
      resourceType: "user",
      resourceId: String(updatedUser.id),
      status: "success",
      req,
    });
    return { user: {
      id: String(updatedUser.id), email: updatedUser.email, name: updatedUser.name,
      role: updatedUser.role, provider: updatedUser.githubId ? "github" : null,
      githubLogin: updatedUser.githubLogin, enabled: !updatedUser.disabledAt,
      lastLoginAt: updatedUser.lastLoginAt, createdAt: updatedUser.createdAt,
    } };
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
