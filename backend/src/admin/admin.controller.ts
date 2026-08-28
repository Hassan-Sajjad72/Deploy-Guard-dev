import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";
import { DataSource } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { AuditLogQueryDto } from "../audit-log/dto/audit-log-query.dto";
import { requireRole } from "../common/rbac/require-role.guard";
import { ProjectCurrentStateService } from "../projects/current-state/project-current-state.service";
import { canonicalDeployguardReusableWorkflow } from "../projects/github-app.service";
import { ProjectsService } from "../projects/projects.service";
import { UserRole } from "../users/user.entity";
import { UsersService } from "../users/users.service";
import { UpdateUserRoleDto } from "./dto/update-user-role.dto";
import { UpdateUserAccessDto } from "./dto/update-user-access.dto";

type ServiceAvailability = {
  status: "available" | "degraded" | "unavailable";
  source: "live_health_probe" | "runtime_configuration";
};

export async function probeGrafanaAvailability(
  configuredUrl: string | undefined,
  request: typeof fetch = fetch,
): Promise<ServiceAvailability> {
  if (!configuredUrl?.trim()) return { status: "unavailable", source: "runtime_configuration" };
  let healthUrl: string;
  try {
    healthUrl = new URL("/api/health", configuredUrl.trim()).toString();
  } catch {
    return { status: "unavailable", source: "runtime_configuration" };
  }
  try {
    const response = await request(healthUrl, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return { status: "degraded", source: "live_health_probe" };
    const health = await response.json() as { database?: unknown };
    return health.database === "ok"
      ? { status: "available", source: "live_health_probe" }
      : { status: "degraded", source: "live_health_probe" };
  } catch {
    return { status: "unavailable", source: "live_health_probe" };
  }
}

@Controller("api/admin")
export class AdminController {
  constructor(
    private readonly usersService: UsersService,
    private readonly auditLogService: AuditLogService,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly projectsService: ProjectsService,
    private readonly projectCurrentStateService: ProjectCurrentStateService,
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
    const grafana = await probeGrafanaAvailability(
      this.config.get<string>("GRAFANA_INTERNAL_URL") || this.config.get<string>("GRAFANA_BASE_URL"),
    );
    let githubActions: ServiceAvailability & {
      releaseIdentity: "unconfigured" | "invalid" | "exact_immutable";
      remoteWorkflowCompatibility: "unconfigured" | "not_checked";
    };
    if (!this.config.get<string>("DEPLOYGUARD_REUSABLE_WORKFLOW")?.trim()) {
      githubActions = { status: "unavailable", source: "runtime_configuration", releaseIdentity: "unconfigured", remoteWorkflowCompatibility: "unconfigured" };
    } else {
      try {
        canonicalDeployguardReusableWorkflow(this.config);
        // This endpoint can prove the same canonical immutable SHA accepted by
        // deployment, but deliberately does not imply that GitHub has remotely
        // verified workflow compatibility. Dispatch performs that live check.
        githubActions = {
          status: "degraded",
          source: "runtime_configuration",
          releaseIdentity: "exact_immutable",
          remoteWorkflowCompatibility: "not_checked",
        };
      } catch {
        githubActions = { status: "degraded", source: "runtime_configuration", releaseIdentity: "invalid", remoteWorkflowCompatibility: "not_checked" };
      }
    }
    const result = {
      generatedAt: new Date().toISOString(),
      services: {
        backend: { status: "available", source: "live_api" },
        database: { status: database ? "available" : "unavailable", source: "postgresql_probe" },
        githubOAuth: { status: configured(["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"]) ? "configured" : "unavailable", source: "runtime_configuration" },
        githubApp: { status: configured(["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"]) ? "configured" : "unavailable", source: "runtime_configuration" },
        githubActions,
        awsOidc: { status: configured(["DEPLOYGUARD_GITHUB_ACTIONS_ROLE_ARN"]) ? "configured" : "unavailable", source: "runtime_configuration" },
        terraformState: { status: configured(["DEPLOYGUARD_TERRAFORM_STATE_BUCKET"]) ? "configured" : "unavailable", source: "runtime_configuration" },
        prometheus: { status: this.config.get<string>("PROMETHEUS_ENABLED") === "true" ? "configured" : "disabled", source: "runtime_configuration" },
        grafana,
      },
      counts: { projects, activeOperations, failedOperations, destroyingOperations },
    };
    await this.auditLogService.record({ actorUser: req.user, action: "ADMIN_OVERVIEW_VIEWED", resourceType: "platform", status: "success", req });
    return result;
  }

  @Get("projects")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async listProjects(@Req() req: Request) {
    const projects = await this.projectsService.listProjects(req.user!);
    const states = await Promise.all(
      projects.map((project) => this.projectCurrentStateService.getCurrentState(req.user!, project.id)),
    );

    return {
      summaries: projects.map((project, index) => ({
        project,
        currentState: states[index],
      })),
    };
  }

  @Get("audit-logs")
  @UseGuards(requireRole([UserRole.ADMIN]))
  listAuditLogs(@Query() query: AuditLogQueryDto, @Req() req: Request) {
    return this.auditLogService.findForUser(req.user!, query);
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
