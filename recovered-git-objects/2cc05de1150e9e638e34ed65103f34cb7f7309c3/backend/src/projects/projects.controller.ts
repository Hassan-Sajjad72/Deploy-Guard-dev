import {
  BadRequestException,
  GoneException,
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
import { DeploymentProfileService } from "./detection/deployment-profile.service";
import { PreflightService } from "./templates/preflight.service";
import { StartPipelineRunDto } from "./dto/start-pipeline-run.dto";
import { PipelineService } from "./pipeline/pipeline.service";
import { StartSecurityScanDto } from "./dto/start-security-scan.dto";
import { ApproveSecurityScanDto } from "./dto/approve-security-scan.dto";
import { SecurityScanService } from "./security/security-scan.service";
import { ProjectCurrentStateService } from "./current-state/project-current-state.service";
import { DetectionStatus } from "./project-detection-profile.entity";
import { PreflightValidationStatus } from "./project-preflight-report.entity";
import { AuditLogService } from "../audit-log/audit-log.service";
import { EntitlementService } from "../billing/entitlement.service";
import { BulkEnvVarsDto } from "./dto/bulk-env-vars.dto";
import { UpdateDatabaseTierDto } from "./dto/update-database-tier.dto";
import { DatabaseTierService } from "./database-tier.service";
import { StageSelectiveResumeService } from "./recovery/stage-selective-resume.service";
import { DeploymentRequirementsService } from "./deployment-requirements.service";
import { ResolveDeploymentRequirementsDto } from "./dto/resolve-deployment-requirements.dto";
import { ProjectActivityDto } from "./dto/project-activity.dto";
import { ProjectActivityService } from "./project-activity.service";
import { rankWorkspaceSummaries } from "./project-recency";
import { NormalReleaseLanePlanningService } from "../orchestration-contracts/release-lane/normal-release-lane-planning.service";
import { NormalFirstReleaseLanePlanningService } from "../orchestration-contracts/release-lane/normal-first-release-lane-planning.service";
import { NormalFirstReleaseInfrastructurePlanExecutionService } from "../orchestration-contracts/release-lane/normal-first-release-infrastructure-plan-execution.service";
import { NormalFirstReleaseInfrastructureApplyExecutionService } from "../orchestration-contracts/release-lane/normal-first-release-infrastructure-apply-execution.service";
import { NormalReleaseLaneStatusService } from "../orchestration-contracts/release-lane/normal-release-lane-status.service";
import { NormalReleaseLaneExecutionService } from "../orchestration-contracts/release-lane/normal-release-lane-execution.service";
import { NormalDeploymentCommandService } from "./normal-deployment-command.service";
import {
  paginateWorkspaceReleaseHistory,
  parseWorkspaceReleaseHistoryFilters,
  summarizeWorkspaceReleaseLane,
  workspaceReleaseHistory,
} from "./current-state/workspace-release-summary";

@Controller("api/projects")
@UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER, UserRole.READONLY]))
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly deploymentProfileService: DeploymentProfileService,
    private readonly preflightService: PreflightService,
    private readonly pipelineService: PipelineService,
    private readonly securityScanService: SecurityScanService,
    private readonly projectCurrentStateService: ProjectCurrentStateService,
    private readonly auditLogService: AuditLogService,
    private readonly entitlements: EntitlementService,
    private readonly databaseTiers: DatabaseTierService,
    private readonly stageSelectiveResume: StageSelectiveResumeService,
    private readonly deploymentRequirements: DeploymentRequirementsService,
    private readonly projectActivity: ProjectActivityService,
    private readonly normalReleaseLanePlanning: NormalReleaseLanePlanningService,
    private readonly normalFirstReleaseLanePlanning: NormalFirstReleaseLanePlanningService,
    private readonly normalFirstReleaseInfrastructurePlanExecution: NormalFirstReleaseInfrastructurePlanExecutionService,
    private readonly normalFirstReleaseInfrastructureApplyExecution: NormalFirstReleaseInfrastructureApplyExecutionService,
    private readonly normalReleaseLaneStatus: NormalReleaseLaneStatusService,
    private readonly normalReleaseLaneExecution: NormalReleaseLaneExecutionService,
    private readonly normalDeploymentCommand: NormalDeploymentCommandService,
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

  @Get()
  async listProjects(@Req() req: Request) {
    return { projects: await this.projectsService.listProjects(req.user!) };
  }

  @Get("workspace-summary")
  async getWorkspaceSummary(@Req() req: Request, @Query() query: Record<string, unknown>) {
    let historyFilters;
    try {
      historyFilters = parseWorkspaceReleaseHistoryFilters(query);
    } catch {
      throw new BadRequestException("Invalid workspace release-history filters.");
    }
    const projects = await this.projectsService.listProjects(req.user!);
    const states = await Promise.allSettled(
      projects.map((project) =>
        this.projectCurrentStateService.getCurrentState(req.user!, project.id)
      )
    );

    const summaries = projects.map((project, index) => ({
      project,
      currentState: states[index].status === "fulfilled" ? states[index].value : null,
    }));
    const ranked = rankWorkspaceSummaries(summaries, req.user!.id);
    const releaseSummary = summarizeWorkspaceReleaseLane(summaries.map((summary) => summary.currentState));
    const releaseHistory = paginateWorkspaceReleaseHistory(workspaceReleaseHistory(summaries.map((summary) => ({
      projectId: summary.project.id,
      projectName: summary.project.name,
      currentState: summary.currentState,
    }))), historyFilters);
    const usage = await this.entitlements.projectUsage(req.user!.id);
    return {
      // `activeRuns` is the same authoritative per-project count used by the
      // dashboard list, so normal v1 work never disappears or double-counts.
      usage: { ...usage, activeRuns: releaseSummary.activeRuns },
      releaseSummary,
      releaseHistory: releaseHistory.items,
      releaseHistoryPage: { nextCursor: releaseHistory.nextCursor, limit: releaseHistory.limit },
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

  @Post(":projectId/detect-stack")
  @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER]))
  async detectStack(@Req() req: Request, @Param("projectId") projectId: string) {
    const profile = await this.deploymentProfileService.runDetection(
        req.user!,
        projectId,
        req
      );
    await this.recordMeaningful(req, projectId, "stack_detection", "detection");
    return { profile };
  }

  @Get(":projectId/detection-profile")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async getDetectionProfile(
    @Req() req: Request,
    @Param("projectId") projectId: string
  ) {
    return {
      profile: await this.deploymentProfileService.getProfile(req.user!, projectId),
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

  @Get(":projectId/current-state/existing-state")
  @Header("Cache-Control", "private, no-store")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async getExistingStateClassification(
    @Req() req: Request,
    @Param("projectId", ParseUUIDPipe) projectId: string,
  ) {
    const currentState = await this.projectCurrentStateService.getDetailedCurrentState(
      req.user!,
      projectId,
    );
    return { existingState: currentState.existingState };
  }

  @Get(":projectId/recovery/resume-preview")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async previewRecoveryResume(
    @Req() req: Request,
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Query("code") code?: string
  ) {
    const state = await this.projectCurrentStateService.getDetailedCurrentState(req.user!, projectId, { refreshCloudState: false });
    if (!state.recoveryIssue) throw new BadRequestException("No actionable recovery issue exists for this project.");
    if (code && state.recoveryIssue.code !== code) throw new BadRequestException("The recovery issue changed. Refresh the project before resuming.");
    return { decision: await this.stageSelectiveResume.preview(req.user!, projectId, state.recoveryIssue) };
  }

  @Post(":projectId/recovery/resume")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async executeRecoveryResume(
    @Req() req: Request,
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Body() body: { code?: string }
  ) {
    throw new GoneException({
      code: "LEGACY_DEPLOYMENT_EXECUTION_RETIRED",
      message: "Legacy stage recovery is retired. Use the guarded v1 release lifecycle or an operator-only recovery package.",
    });
  }

  @Post(":projectId/automation/start")
  async startAutomation(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    shadowOrigin: "new" | "retry" = "new",
  ) {
    throw new GoneException({
      code: "LEGACY_DEPLOYMENT_EXECUTION_RETIRED",
      message: "Legacy automation deployment is retired. Eligible projects use the guarded v1 release lifecycle; other scopes are unavailable.",
    });
  }

  @Post(":projectId/release-lane/prepare")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async prepareReleaseLane(
    @Req() req: Request,
    @Param("projectId", ParseUUIDPipe) projectId: string,
  ) {
    const firstRelease = await this.normalFirstReleaseLanePlanning.prepare(req.user!, projectId);
    const releaseLane = firstRelease.state === "not_applicable"
      ? await this.normalReleaseLanePlanning.prepare(req.user!, projectId)
      : firstRelease;
    if (releaseLane.state === "prepared") {
      await this.recordMeaningful(req, projectId, "release_lane_prepared", "pipeline");
    }
    return { releaseLane };
  }

  @Post(":projectId/release-lane/dispatch")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async dispatchReleaseLane(
    @Req() req: Request,
    @Param("projectId", ParseUUIDPipe) projectId: string,
  ) {
    return {
      releaseLane: await this.normalReleaseLaneExecution.dispatch(req.user!, projectId),
    };
  }

  @Post(":projectId/release-lane/infrastructure-plan/dispatch")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async dispatchFirstReleaseInfrastructurePlan(
    @Req() req: Request,
    @Param("projectId", ParseUUIDPipe) projectId: string,
  ) {
    return {
      infrastructurePlan: await this.normalFirstReleaseInfrastructurePlanExecution.dispatch(
        req.user!, projectId,
      ),
    };
  }

  @Post(":projectId/release-lane/infrastructure-apply/dispatch")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async dispatchFirstReleaseInfrastructureApply(@Req() req: Request, @Param("projectId", ParseUUIDPipe) projectId: string) {
    return { infrastructureApply: await this.normalFirstReleaseInfrastructureApplyExecution.dispatch(req.user!, projectId) };
  }

  @Post(":projectId/deploy")
  @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER]))
  async deployNormalV1(
    @Req() req: Request,
    @Param("projectId", ParseUUIDPipe) projectId: string,
  ) {
    const result = await this.normalDeploymentCommand.deploy(req.user!, projectId);
    if (result.deployment.state === "accepted") {
      await this.recordMeaningful(req, projectId, "normal_deployment_requested", "pipeline");
    }
    return result;
  }

  @Post(":projectId/deploy/approve-cost")
  @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER]))
  async approveNormalV1Cost(
    @Req() req: Request,
    @Param("projectId", ParseUUIDPipe) projectId: string,
  ) {
    const result = await this.normalDeploymentCommand.approveCost(req.user!, projectId);
    if (result.deployment.state === "accepted") {
      await this.recordMeaningful(req, projectId, "normal_deployment_cost_approved", "pipeline");
    }
    return result;
  }

  @Get(":projectId/release-lane/status")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async getReleaseLaneStatus(
    @Req() req: Request,
    @Param("projectId", ParseUUIDPipe) projectId: string,
  ) {
    return { releaseLane: await this.normalReleaseLaneStatus.get(req.user!, projectId) };
  }

  @Post(":projectId/preflight")
  @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER]))
  async generatePreflight(
    @Req() req: Request,
    @Param("projectId") projectId: string
  ) {
    const report = await this.preflightService.generateReport(req.user!, projectId, req);
    await this.recordMeaningful(req, projectId, "preflight_generated", "requirements");
    return { report };
  }

  @Get(":projectId/preflight")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async getPreflight(@Req() req: Request, @Param("projectId") projectId: string) {
    return {
      report: await this.preflightService.getReport(req.user!, projectId),
    };
  }

  @Post(":projectId/pipeline/runs")
  async startPipelineRun(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Body() dto: StartPipelineRunDto
  ) {
    throw new GoneException({
      code: "LEGACY_DEPLOYMENT_EXECUTION_RETIRED",
      message: "Legacy pipeline execution is retired. Use the guarded v1 release lifecycle when eligible.",
    });
  }

  @Get(":projectId/pipeline/runs")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async listPipelineRuns(
    @Req() req: Request,
    @Param("projectId") projectId: string
  ) {
    return {
      pipelineRuns: await this.pipelineService.listRuns(req.user!, projectId),
    };
  }

  @Get(":projectId/pipeline/runs/:runId")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async getPipelineRun(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string
  ) {
    return {
      pipelineRun: await this.pipelineService.getRun(req.user!, projectId, runId),
    };
  }

  @Get(":projectId/pipeline/runs/:runId/events")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async listPipelineEvents(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string
  ) {
    return {
      events: await this.pipelineService.listEvents(req.user!, projectId, runId),
    };
  }

  @Post(":projectId/pipeline/runs/:runId/cancel")
  async cancelPipelineRun(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string
  ) {
    throw new GoneException({
      code: "LEGACY_DEPLOYMENT_EXECUTION_RETIRED",
      message: "Legacy pipeline cancellation is retired. Normal-v1 lifecycle controls are authoritative.",
    });
  }

  @Post(":projectId/pipeline/runs/:runId/retry")
  async retryPipelineRun(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string
  ) {
    throw new GoneException({
      code: "LEGACY_DEPLOYMENT_EXECUTION_RETIRED",
      message: "Legacy pipeline retry is retired. Use the guarded v1 release lifecycle when eligible.",
    });
  }

  @Post(":projectId/pipeline/runs/:runId/approve-apply")
  @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER]))
  async approveTerraformApply(
    @Req() req: Request,
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Param("runId", new ParseUUIDPipe({ version: "4" })) runId: string
  ) {
    throw new GoneException({
      code: "LEGACY_DEPLOYMENT_EXECUTION_RETIRED",
      message: "Legacy Terraform approval is retired. Use the exact normal-v1 infrastructure apply action.",
    });
  }

  @Post(":projectId/security-scans")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async triggerSecurityScan(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Body() dto: StartSecurityScanDto
  ) {
    const scan = await this.securityScanService.triggerScan(
        req.user!,
        projectId,
        dto,
        req
      );
    await this.recordMeaningful(req, projectId, "security_scan_started", "security");
    return { scan };
  }

  @Get(":projectId/security-scans")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async listSecurityScans(
    @Req() req: Request,
    @Param("projectId") projectId: string
  ) {
    return {
      scans: await this.securityScanService.listScans(req.user!, projectId),
    };
  }

  @Get(":projectId/security-scans/:scanId")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async getSecurityScan(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Param("scanId") scanId: string
  ) {
    return {
      scan: await this.securityScanService.getScan(req.user!, projectId, scanId),
    };
  }

  @Get(":projectId/security-scans/:scanId/findings")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async listSecurityFindings(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Param("scanId") scanId: string,
    @Query() query: Record<string, string>
  ) {
    return this.securityScanService.listFindings(
      req.user!,
      projectId,
      scanId,
      query
    );
  }

  @Post(":projectId/security-scans/:scanId/approve")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async approveSecurityScan(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Param("scanId") scanId: string,
    @Body() dto: ApproveSecurityScanDto
  ) {
    const scan = await this.securityScanService.approveScan(
        req.user!,
        projectId,
        scanId,
        dto,
        req
      );
    await this.recordMeaningful(req, projectId, "security_scan_approved", "security");
    return { scan };
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
    const variable = await this.attemptProjectAction(req, "PROJECT_ENV_CREATED", projectId, () => this.projectsService.createEnvVar(req.user!, projectId, dto, req));
    return { variable, preflight: await this.refreshPreflightAfterEnvironmentSave(req, projectId) };
  }

  @Post(":projectId/env/bulk")
  async bulkUpsertEnvVars(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Body() dto: BulkEnvVarsDto
  ) {
    const variables = await this.attemptProjectAction(req, "PROJECT_ENV_BULK_UPSERTED", projectId, () =>
      this.projectsService.bulkUpsertEnvVars(req.user!, projectId, dto, req)
    );
    return { variables, preflight: await this.refreshPreflightAfterEnvironmentSave(req, projectId) };
  }

  @Patch(":projectId/env/:envId")
  async updateEnvVar(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Param("envId") envId: string,
    @Body() dto: UpdateEnvVarDto
  ) {
    const variable = await this.attemptProjectAction(req, "PROJECT_ENV_UPDATED", projectId, () => this.projectsService.updateEnvVar(
        req.user!,
        projectId,
        envId,
        dto,
        req
      ));
    return { variable, preflight: await this.refreshPreflightAfterEnvironmentSave(req, projectId) };
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

  private async refreshPreflightAfterEnvironmentSave(req: Request, projectId: string) {
    try {
      return await this.preflightService.generateReport(req.user!, projectId, req);
    } catch {
      return null;
    }
  }
}
