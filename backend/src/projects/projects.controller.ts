import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Request } from "express";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";
import { CreateEnvVarDto } from "./dto/create-env-var.dto";
import { CreateProjectDto } from "./dto/create-project.dto";
import { UpdateBranchDto } from "./dto/update-branch.dto";
import { UpdateEnvVarDto } from "./dto/update-env-var.dto";
import { UpdateProjectDto } from "./dto/update-project.dto";
import { UpdateRepositoryDto } from "./dto/update-repository.dto";
import { ProjectsService } from "./projects.service";
import { ProjectCurrentStateService } from "./current-state/project-current-state.service";
import { AuditLogService } from "../audit-log/audit-log.service";
import { BulkEnvVarsDto } from "./dto/bulk-env-vars.dto";
import { UpdateDatabaseTierDto } from "./dto/update-database-tier.dto";
import { DatabaseTierService } from "./database-tier.service";
import { DeploymentRequirementsService } from "./deployment-requirements.service";
import { ResolveDeploymentRequirementsDto } from "./dto/resolve-deployment-requirements.dto";
import { ProjectActivityDto } from "./dto/project-activity.dto";
import { ProjectActivityService } from "./project-activity.service";
import { rankWorkspaceSummaries } from "./project-recency";
import { GithubActionsDeploymentService } from "./github-actions-deployment.service";
import { RollbackGithubActionsDto } from "./dto/rollback-github-actions.dto";
import { ManagedDatabaseReconciliationService } from "./managed-database-reconciliation.service";
import { ManagedDatabaseResetService } from "./managed-database-reset.service";
import { DeploymentRecoveryDecisionService } from "./deployment-recovery-decision.service";

@Controller("api/projects")
@UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER, UserRole.READONLY]))
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly projectCurrentStateService: ProjectCurrentStateService,
    private readonly auditLogService: AuditLogService,
    private readonly databaseTiers: DatabaseTierService,
    private readonly deploymentRequirements: DeploymentRequirementsService,
    private readonly projectActivity: ProjectActivityService,
    private readonly githubActionsDeployment: GithubActionsDeploymentService,
    private readonly managedDatabaseReconciliation: ManagedDatabaseReconciliationService,
    private readonly managedDatabaseReset: ManagedDatabaseResetService,
    private readonly deploymentRecovery: DeploymentRecoveryDecisionService,
  ) {}

  @Get(":projectId/deployment-requirements")
  async getDeploymentRequirements(@Req() req: Request, @Param("projectId", ParseUUIDPipe) projectId: string) {
    return { requirements: await this.deploymentRequirements.get(req.user!, projectId) };
  }

  @Post(":projectId/deployment-requirements/resolve")
  @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER]))
  async resolveDeploymentRequirements(
    @Req() req: Request,
    @Param("projectId", ParseUUIDPipe) projectId: string,
    @Body() dto: ResolveDeploymentRequirementsDto
  ) {
    const response = await this.deploymentRequirements.resolve(req.user!, projectId, dto, req);
    await this.recordMeaningful(req, projectId, "deployment_requirements_saved", "requirements");
    return response;
  }

  @Get(":projectId/database-tier")
  async getDatabaseTier(@Req() req: Request, @Param("projectId", ParseUUIDPipe) projectId: string) {
    return { database: await this.databaseTiers.get(req.user!, projectId) };
  }

  @Patch(":projectId/database-tier")
  async updateDatabaseTier(@Req() req: Request, @Param("projectId", ParseUUIDPipe) projectId: string, @Body() dto: UpdateDatabaseTierDto) {
    const database = await this.databaseTiers.update(req.user!, projectId, dto, req);
    await this.recordMeaningful(req, projectId, "database_settings_saved", "requirements");
    return { database };
  }

  @Get(":projectId/database-reconciliation")
  async getManagedDatabaseReconciliation(@Req() req: Request, @Param("projectId", ParseUUIDPipe) projectId: string) {
    const project = await this.projectsService.getProjectEntityForView(req.user!, projectId);
    const databaseReconciliation = await this.managedDatabaseReconciliation.reconcile(project);
    const deploymentDecision = await this.deploymentRecovery.decide(projectId, databaseReconciliation, "DEPLOY");
    return { databaseReconciliation: { ...databaseReconciliation, deploymentDecision } };
  }

  @Post(":projectId/database-reset")
  @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER]))
  async resetManagedDatabase(
    @Req() req: Request,
    @Param("projectId", ParseUUIDPipe) projectId: string,
    @Body() body: { confirmationPhrase?: string },
  ) {
    const reset = await this.managedDatabaseReset.reset(req.user!, projectId, String(body.confirmationPhrase || ""), req);
    await this.recordMeaningful(req, projectId, "managed_database_reset", "requirements");
    return { reset };
  }

  @Get()
  async listProjects(@Req() req: Request) {
    return { projects: await this.projectsService.listProjects(req.user!) };
  }

  @Get("workspace-summary")
  async getWorkspaceSummary(@Req() req: Request) {
    const projects = await this.projectsService.listProjects(req.user!);
    const states = await Promise.all(
      projects.map((project) => this.projectCurrentStateService.getCurrentState(req.user!, project.id)),
    );

    const summaries = projects.map((project, index) => ({
      project,
      currentState: states[index],
    }));
    const ranked = rankWorkspaceSummaries(summaries, req.user!.id);
    const stateValues = summaries.map((summary) => summary.currentState?.developerState);
    const activeRuns = stateValues.filter((state) => ["preparing", "queued", "building", "deploying", "verifying", "destroying"].includes(state || "")).length;
    const deploymentSummary = {
      activeRuns,
      liveProjects: stateValues.filter((state) => state === "live").length,
      failedProjects: stateValues.filter((state) => state === "failed_application").length,
      destroyedProjects: stateValues.filter((state) => state === "destroyed").length,
    };
    return {
      usage: { totalProjects: projects.length, activeProjects: projects.length, activeRuns },
      deploymentSummary,
      summaries: ranked.ordered,
      continueWorking: ranked.continueWorking,
      needsAttention: ranked.attention,
      recentlyViewed: ranked.recentlyViewed,
      liveProjects: ranked.live,
      // Cloud inventory and residue are operator evidence. New-project pages do
      // not receive infrastructure identities or cleanup instructions.
      creationWarnings: [],
    };
  }

  @Post(":projectId/activity/view")
  async recordProjectView(@Req() req: Request, @Param("projectId", ParseUUIDPipe) projectId: string, @Body() dto: ProjectActivityDto) {
    await this.projectsService.getProjectEntityForView(req.user!, projectId);
    await this.projectActivity.recordView(req.user!.id, projectId, dto);
    return { recorded: true };
  }

  @Get("github/repositories")
  async listGithubRepositories(@Req() req: Request) {
    return { repositories: await this.projectsService.listGithubRepositories(req.user!) };
  }

  @Get("github/status")
  async githubStatus(@Req() req: Request) {
    return this.projectsService.githubConnectionStatus(req.user!);
  }

  @Post("github/installations/:installationId/connect")
  @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER]))
  async connectGithubInstallation(@Req() req: Request, @Param("installationId") installationId: string) {
    const connection = await this.projectsService.connectGithubInstallation(req.user!, installationId);
    await this.auditLogService.record({
      actorUser: req.user!,
      action: "GITHUB_APP_INSTALLATION_CONNECTED",
      resourceType: "github_app_installation",
      resourceId: connection.installationId,
      status: "success",
      metadata: { installationId: connection.installationId },
      req,
    });
    return connection;
  }

  @Get("github/repositories/:owner/:repository")
  async inspectGithubRepository(
    @Req() req: Request,
    @Param("owner") owner: string,
    @Param("repository") repository: string
  ) {
    return { repository: await this.projectsService.inspectGithubRepository(req.user!, `${owner}/${repository}`) };
  }

  @Get("github/repositories/:owner/:repository/branches")
  async listGithubRepositoryBranches(
    @Req() req: Request,
    @Param("owner") owner: string,
    @Param("repository") repository: string
  ) {
    return { branches: await this.projectsService.listGithubRepositoryBranches(req.user!, `${owner}/${repository}`) };
  }

  @Post()
  async createProject(@Req() req: Request, @Body() dto: CreateProjectDto) {
    return {
      project: await this.attemptProjectAction(req, "PROJECT_CREATED", null, () => this.projectsService.createProject(req.user!, dto, req)),
    };
  }


  @Get(":projectId/current-state")
  @Header("Cache-Control", "private, no-store")
  async getCurrentState(
    @Req() req: Request,
    @Param("projectId") projectId: string
  ) {
    return this.projectCurrentStateService.getCurrentState(req.user!, projectId);
  }

  @Get(":projectId/current-state/details")
  @Header("Cache-Control", "private, no-store")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async getDetailedCurrentState(
    @Req() req: Request,
    @Param("projectId", ParseUUIDPipe) projectId: string,
  ) {
    return this.projectCurrentStateService.getDetailedCurrentState(req.user!, projectId);
  }

  @Post(":projectId/deploy")
  @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER]))
  async deployGithubActions(
    @Req() req: Request,
    @Param("projectId", ParseUUIDPipe) projectId: string,
  ) {
    const result = await this.githubActionsDeployment.deploy(req.user!, projectId);
    if (result.deployment.state === "accepted") {
      await this.recordMeaningful(req, projectId, "github_actions_deployment_requested", "pipeline");
      await this.auditLogService.record({
        actorUser: req.user!,
        action: "GITHUB_ACTIONS_DEPLOYMENT_REQUESTED",
        resourceType: "pipeline_run",
        resourceId: result.deployment.operation.id,
        status: "success",
        metadata: { projectId, operationId: result.deployment.operation.id, deploymentAction: "deploy" },
        req,
      });
    }
    return result;
  }

  @Get(":projectId/deploy/status")
  async githubActionsDeploymentStatus(@Req() req: Request, @Param("projectId", ParseUUIDPipe) projectId: string) {
    return this.githubActionsDeployment.latest(req.user!, projectId);
  }

  @Get(":projectId/deploy/history")
  async githubActionsDeploymentHistory(@Req() req: Request, @Param("projectId", ParseUUIDPipe) projectId: string) {
    return this.githubActionsDeployment.history(req.user!, projectId);
  }

  @Post(":projectId/deploy/retry")
  @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER]))
  async retryGithubActionsDeployment(@Req() req: Request, @Param("projectId", ParseUUIDPipe) projectId: string) {
    const result = await this.githubActionsDeployment.retry(req.user!, projectId);
    if (result.deployment.state === "accepted") {
      await this.recordMeaningful(req, projectId, "github_actions_deployment_retried", "pipeline");
      await this.auditLogService.record({
        actorUser: req.user!,
        action: "GITHUB_ACTIONS_DEPLOYMENT_RETRIED",
        resourceType: "pipeline_run",
        resourceId: result.deployment.operation.id,
        status: "success",
        metadata: { projectId, operationId: result.deployment.operation.id, retryOfOperationId: result.deployment.operation.retryOfOperationId },
        req,
      });
    } else if (result.deployment.state === "rejected") {
      await this.auditLogService.record({
        actorUser: req.user!,
        action: "GITHUB_ACTIONS_DEPLOYMENT_RETRY_REJECTED",
        resourceType: "pipeline_run",
        resourceId: result.deployment.operation.id,
        status: "failed",
        metadata: {
          projectId,
          operationId: result.deployment.operation.id,
          retryOfOperationId: result.deployment.operation.retryOfOperationId,
          reason: result.deployment.message,
        },
        req,
      });
    }
    return result;
  }

  @Post(":projectId/deploy/reset-fresh")
  @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER]))
  async resetAndDeployFresh(
    @Req() req: Request,
    @Param("projectId", ParseUUIDPipe) projectId: string,
    @Body() body: { confirmationPhrase?: string },
  ) {
    const result = await this.githubActionsDeployment.resetAndDeployFresh(
      req.user!,
      projectId,
      String(body.confirmationPhrase || ""),
      req,
    );
    if (result.deployment.state === "accepted") {
      await this.recordMeaningful(req, projectId, "github_actions_reset_fresh_requested", "pipeline");
      await this.auditLogService.record({
        actorUser: req.user!,
        action: "GITHUB_ACTIONS_RESET_FRESH_REQUESTED",
        resourceType: "pipeline_run",
        resourceId: result.deployment.operation.id,
        status: "success",
        metadata: { projectId, operationId: result.deployment.operation.id, deploymentMode: "RESET_FRESH" },
        req,
      });
    }
    return result;
  }

  @Get(":projectId/deploy/rollback-candidates")
  async githubActionsRollbackCandidates(
    @Req() req: Request,
    @Param("projectId", ParseUUIDPipe) projectId: string,
  ) {
    return this.githubActionsDeployment.rollbackCandidates(req.user!, projectId);
  }

  @Post(":projectId/deploy/rollback")
  @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER]))
  async rollbackGithubActions(
    @Req() req: Request,
    @Param("projectId", ParseUUIDPipe) projectId: string,
    @Body() dto: RollbackGithubActionsDto,
  ) {
    const result = await this.githubActionsDeployment.rollback(req.user!, projectId, dto.targetOperationId);
    if (result.deployment.state === "accepted") {
      await this.recordMeaningful(req, projectId, "github_actions_rollback_requested", "pipeline");
      await this.auditLogService.record({
        actorUser: req.user!,
        action: "GITHUB_ACTIONS_ROLLBACK_REQUESTED",
        resourceType: "pipeline_run",
        resourceId: result.deployment.operation.id,
        status: "success",
        metadata: {
          projectId,
          operationId: result.deployment.operation.id,
          targetOperationId: dto.targetOperationId,
          deploymentAction: "rollback",
        },
        req,
      });
    }
    return result;
  }

  @Post(":projectId/deploy/destroy")
  @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER]))
  async destroyGithubActionsDeployment(@Req() req: Request, @Param("projectId", ParseUUIDPipe) projectId: string, @Body() body: { confirmationPhrase?: string }) {
    const result = await this.githubActionsDeployment.destroy(req.user!, projectId, String(body.confirmationPhrase || ""));
    if (result.deployment.state === "accepted") {
      await this.recordMeaningful(req, projectId, "github_actions_destroy_requested", "pipeline");
      await this.auditLogService.record({
        actorUser: req.user!,
        action: "GITHUB_ACTIONS_DESTROY_REQUESTED",
        resourceType: "pipeline_run",
        resourceId: result.deployment.operation.id,
        status: "success",
        metadata: { projectId, operationId: result.deployment.operation.id, deploymentAction: "destroy" },
        req,
      });
    }
    return result;
  }



  @Get(":projectId")
  async getProject(@Req() req: Request, @Param("projectId") projectId: string) {
    return {
      project: await this.projectsService.getProjectForView(req.user!, projectId),
    };
  }

  @Patch(":projectId")
  async updateProject(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Body() dto: UpdateProjectDto
  ) {
    return {
      project: await this.attemptProjectAction(req, "PROJECT_UPDATED", projectId, () => this.projectsService.updateProject(req.user!, projectId, dto, req)),
    };
  }

  @Delete(":projectId")
  async archiveProject(@Req() req: Request, @Param("projectId") projectId: string) {
    await this.attemptProjectAction(req, "PROJECT_ARCHIVED", projectId, () => this.projectsService.archiveProject(req.user!, projectId, req));

    return { message: "Project archived successfully" };
  }

  @Patch(":projectId/repository")
  async updateRepository(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Body() dto: UpdateRepositoryDto
  ) {
    return {
      project: await this.attemptProjectAction(req, "PROJECT_REPOSITORY_LINKED", projectId, () => this.projectsService.updateRepository(
        req.user!,
        projectId,
        dto,
        req
      )),
    };
  }

  @Get(":projectId/branches")
  async getBranches(@Req() req: Request, @Param("projectId") projectId: string) {
    return {
      branches: await this.projectsService.getBranches(req.user!, projectId),
    };
  }

  @Patch(":projectId/branch")
  async updateBranch(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Body() dto: UpdateBranchDto
  ) {
    return {
      project: await this.attemptProjectAction(req, "PROJECT_BRANCH_UPDATED", projectId, () => this.projectsService.updateBranch(req.user!, projectId, dto, req)),
    };
  }

  @Get(":projectId/env")
  async listEnvVars(@Req() req: Request, @Param("projectId") projectId: string) {
    return this.projectsService.getEnvVarSetup(req.user!, projectId);
  }

  @Post(":projectId/env")
  async createEnvVar(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Body() dto: CreateEnvVarDto
  ) {
    const result = await this.attemptProjectAction(req, "PROJECT_ENV_CREATED", projectId, () => this.projectsService.createEnvVar(req.user!, projectId, dto, req));
    return result;
  }

  @Post(":projectId/env/bulk")
  async bulkUpsertEnvVars(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Body() dto: BulkEnvVarsDto
  ) {
    const result = await this.attemptProjectAction(req, "PROJECT_ENV_BULK_UPSERTED", projectId, () =>
      this.projectsService.bulkUpsertEnvVars(req.user!, projectId, dto, req)
    );
    return result;
  }

  @Patch(":projectId/env/:envId")
  async updateEnvVar(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Param("envId") envId: string,
    @Body() dto: UpdateEnvVarDto
  ) {
    const result = await this.attemptProjectAction(req, "PROJECT_ENV_UPDATED", projectId, () => this.projectsService.updateEnvVar(
        req.user!,
        projectId,
        envId,
        dto,
        req
      ));
    return result;
  }

  @Delete(":projectId/env/:envId")
  async deleteEnvVar(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Param("envId") envId: string
  ) {
    await this.attemptProjectAction(req, "PROJECT_ENV_DELETED", projectId, () => this.projectsService.deleteEnvVar(req.user!, projectId, envId, req));

    return { message: "Environment variable deleted successfully" };
  }

  private async attemptProjectAction<T>(req: Request, action: string, projectId: string | null, work: () => Promise<T>): Promise<T> {
    try {
      const result = await work();
      if (projectId) await this.recordMeaningful(req, projectId, action.toLowerCase());
      return result;
    } catch (error) {
      await this.auditLogService.record({
        actorUser: req.user!,
        action,
        resourceType: "project",
        resourceId: projectId,
        status: "failed",
        metadata: { ...(projectId ? { projectId } : {}), errorType: error instanceof Error ? error.name : "ProjectActionError" },
        req,
      });
      throw error;
    }
  }

  private async recordMeaningful(req: Request, projectId: string, action: string, fallbackSection = "overview") {
    const routeHeader = req.headers["x-deployguard-route"];
    const route = typeof routeHeader === "string" && routeHeader.startsWith(`/projects/${projectId}`)
      ? routeHeader
      : `/projects/${projectId}/${fallbackSection}`.replace(/\/overview$/, "");
    await this.projectActivity.recordUserAction(req.user!.id, projectId, action, { route, section: fallbackSection });
  }

}
