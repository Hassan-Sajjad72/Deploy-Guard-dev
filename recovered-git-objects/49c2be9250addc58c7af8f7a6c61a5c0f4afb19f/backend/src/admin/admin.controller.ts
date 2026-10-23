import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  ParseUUIDPipe,
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
import { AdminAuthorizationService } from "./admin-authorization.service";
import { assertInternalAdminScope } from "./internal-admin-scope";
import { AdminAccountControlDto, VerifyAdminIdentityDto } from "./dto/admin-controls.dto";

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
    private readonly authorization: AdminAuthorizationService,
  ) {}

  @Get("overview")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async overview(@Req() req: Request) {
    assertInternalAdminScope(req.user!, "platform_ops");
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
          COUNT(*) FILTER (WHERE operation."status" IN ('queued', 'running'))::int AS active,
          COUNT(*) FILTER (WHERE operation."status" = 'failed')::int AS failed,
          COUNT(*) FILTER (WHERE operation."status" IN ('queued', 'running') AND operation."metadata" ->> 'deploymentAction' = 'destroy')::int AS destroying
          FROM "project_pipeline_runs" operation
          JOIN "projects" project ON project."id" = operation."project_id"
          WHERE project."status" != 'archived' AND operation."metadata" ->> 'executionEngine' = 'github_actions'`),
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
    assertInternalAdminScope(req.user!, "platform_ops");
    const summaries = await this.dataSource.query(`SELECT id,name,status,organization_id AS "organizationId",created_at AS "createdAt" FROM projects ORDER BY created_at DESC LIMIT 200`);
    await this.auditLogService.record({ actorUser: req.user, action: "ADMIN_PROJECT_STATUS_VIEWED", resourceType: "platform", status: "success", req });
    return { summaries: summaries.map((project: unknown) => ({ project, currentState: null })) };
  }

  @Get("audit-logs")
  @UseGuards(requireRole([UserRole.ADMIN]))
  listAuditLogs(@Query() query: AuditLogQueryDto, @Req() req: Request) {
    assertInternalAdminScope(req.user!, "security_auditor");
    return this.auditLogService.findForUser(req.user!, query);
  }

  @Get("users")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async listUsers(@Req() req: Request) {
    assertInternalAdminScope(req.user!, "super_admin");
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
        internalAdminRole: user.internalAdminRole,
        provider: user.githubId ? "github" : null,
        githubLogin: user.githubLogin,
        enabled: !user.disabledAt,
        lastLoginAt: user.lastLoginAt,
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
    assertInternalAdminScope(req.user!, "super_admin");
    await this.authorization.requireRecentVerification(req.user!);
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
        reason: dto.reason.trim(),
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

  @Post("verify-identity")
  @UseGuards(requireRole([UserRole.ADMIN]))
  verifyIdentity(@Body() dto: VerifyAdminIdentityDto, @Req() req: Request) { return this.authorization.verifyIdentity(req.user!, dto.password); }

  @Patch("users/:userId/controls")
  @UseGuards(requireRole([UserRole.ADMIN]))
  updateAccount(@Param("userId", ParseIntPipe) userId: number, @Body() dto: AdminAccountControlDto, @Req() req: Request) { return this.authorization.updateAccount(req.user!, userId, dto); }

  @Get("support-access")
  @UseGuards(requireRole([UserRole.ADMIN]))
  supportGrants(@Req() req: Request) { return this.authorization.listSupport(req.user!); }

  @Get("support-access/:grantId/projects/:projectId")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async supportEvidence(@Param("grantId", ParseUUIDPipe) grantId: string, @Param("projectId", ParseUUIDPipe) projectId: string, @Req() req: Request) {
    const authorizedViewer = await this.authorization.supportProject(req.user!, grantId, projectId);
    const state = await this.projectCurrentStateService.getCurrentState(authorizedViewer, projectId);
    return { projectId, stateAuthority: state.stateAuthority, release: state.stableRelease ? { id: state.stableRelease.id, commit: state.stableRelease.commit, promotedAt: state.stableRelease.promotedAt } : null };
  }
}
