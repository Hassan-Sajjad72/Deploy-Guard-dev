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
    private readonly projectActivity: ProjectActivityService
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
  async getWorkspaceSummary(@Req() req: Request) {
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
    return {
      usage: await this.entitlements.projectUsage(req.user!.id),
      summaries: ranked.ordered,
      continueWorking: ranked.continueWorking,
      needsAttention: ranked.attention,
      recentlyViewed: ranked.recentlyViewed,
      liveProjects: ranked.live,
      creationWarnings: ranked.attention.filter(({ currentState }) =>
        ["active_resources", "cleanup_required", "manual_review_required"].includes(currentState?.resourceStatus)
      ).map(({ project, currentState }) => ({
        projectId: project.id,
        projectName: project.name,
        deploymentStatus: currentState?.deploymentStatus,
        resourceStatus: currentState?.resourceStatus,
        potentialCost: "Active AWS resources may incur cost. Review NAT, ALB, ECS, EFS, and database resources shown by inventory.",
        reviewHref: `/projects/${project.id}/settings`,
      })),
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

  @Get(":projectId/recovery/resume-preview")
  @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER]))
  async previewRecoveryResume(
    @Req() req: Request,
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Query("code") code?: string
  ) {
    const state = await this.projectCurrentStateService.getCurrentState(req.user!, projectId, { refreshCloudState: false });
    if (!state.recoveryIssue) throw new BadRequestException("No actionable recovery issue exists for this project.");
    if (code && state.recoveryIssue.code !== code) throw new BadRequestException("The recovery issue changed. Refresh the project before resuming.");
    return { decision: await this.stageSelectiveResume.preview(req.user!, projectId, state.recoveryIssue) };
  }

  @Post(":projectId/recovery/resume")
  @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER]))
  async executeRecoveryResume(
    @Req() req: Request,
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Body() body: { code?: string }
  ) {
    const state = await this.projectCurrentStateService.getCurrentState(req.user!, projectId, { refreshCloudState: false });
    if (!state.recoveryIssue) throw new BadRequestException("No actionable recovery issue exists for this project.");
    if (body?.code && state.recoveryIssue.code !== body.code) throw new BadRequestException("The recovery issue changed. Refresh the project before resuming.");
    const response = await this.stageSelectiveResume.execute(req.user!, projectId, state.recoveryIssue, req);
    await this.recordMeaningful(req, projectId, "recovery_resume", "recovery");
    return response;
  }

  @Post(":projectId/automation/start")
  async startAutomation(
    @Req() req: Request,
    @Param("projectId") projectId: string
  ) {
    await this.projectsService.getProjectEntityForManage(req.user!, projectId);
    const currentState = await this.projectCurrentStateService.getCurrentState(
      req.user!,
      projectId
    );

    if (["queued", "running", "paused"].includes(currentState.latestPipeline.status)) {
      return {
        automation: {
          status: currentState.latestPipeline.status,
          currentStage: currentState.currentStep,
          pipelineRun: currentState.latestPipeline,
          message: "An automation run is already active for this project.",
        },
      };
    }

    const profile = await this.deploymentProfileService.getOrRunDetection(
      req.user!,
      projectId,
      req
    );
    if (
      [DetectionStatus.FAILED, DetectionStatus.NEEDS_MANUAL_DOCKERFILE].includes(
        profile.detectionStatus as DetectionStatus
      )
    ) {
      return {
        automation: {
          status: "failed",
          currentStage: "stack_detection",
          pipelineRun: null,
          message:
            profile.unsupportedReason ||
            profile.errors?.[0] ||
            "Stack detection could not produce a deployable application profile.",
        },
      };
    }

    const report = await this.preflightService.getOrGenerateReport(
      req.user!,
      projectId,
      req
    );
    if (
      ![
        PreflightValidationStatus.PASSED,
        PreflightValidationStatus.PASSED_WITH_WARNINGS,
      ].includes(report.validationStatus as PreflightValidationStatus)
    ) {
      return {
        automation: {
          status: "failed",
          currentStage: "preflight",
          pipelineRun: null,
          message:
            report.errors?.[0] ||
            "Pre-flight validation did not produce a deployable configuration.",
        },
      };
    }

    const pipelineRun = await this.pipelineService.startRun(
      req.user!,
      projectId,
      { triggerGithubActions: false },
      req
    );

    return {
      automation: {
        status: pipelineRun.status,
        currentStage: pipelineRun.currentStage,
        pipelineRun,
        message:
          "DeployGuard automation is queued. Current detection and pre-flight evidence was reused when its fingerprint matched; stale evidence was regenerated automatically.",
      },
    };
  }

  @Post(":projectId/preflight")
  async generatePreflight(
    @Req() req: Request,
    @Param("projectId") projectId: string
  ) {
    const report = await this.preflightService.generateReport(req.user!, projectId, req);
    await this.recordMeaningful(req, projectId, "preflight_generated", "requirements");
    return { report };
  }

  @Get(":projectId/preflight")
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
    return {
      pipelineRun: await this.pipelineService.startRun(
        req.user!,
        projectId,
        dto,
        req
      ),
    };
  }

  @Get(":projectId/pipeline/runs")
  async listPipelineRuns(
    @Req() req: Request,
    @Param("projectId") projectId: string
  ) {
    return {
      pipelineRuns: await this.pipelineService.listRuns(req.user!, projectId),
    };
  }

  @Get(":projectId/pipeline/runs/:runId")
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
    return {
      pipelineRun: await this.pipelineService.cancelRun(
        req.user!,
        projectId,
        runId,
        req
      ),
    };
  }

  @Post(":projectId/pipeline/runs/:runId/retry")
  async retryPipelineRun(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string
  ) {
    await this.pipelineService.assertRetryableRun(req.user!, projectId, runId);
    const response = await this.startAutomation(req, projectId);
    return {
      pipelineRun: response.automation.pipelineRun,
      automation: response.automation,
    };
  }

  @Post(":projectId/pipeline/runs/:runId/approve-apply")
  @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER]))
  async approveTerraformApply(
    @Req() req: Request,
    @Param("projectId", new ParseUUIDPipe({ version: "4" })) projectId: string,
    @Param("runId", new ParseUUIDPipe({ version: "4" })) runId: string
  ) {
    return {
      pipelineRun: await this.pipelineService.approveTerraformApply(
        req.user!, projectId, runId, req
      ),
    };
  }

  @Post(":projectId/security-scans")
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
  async listSecurityScans(
    @Req() req: Request,
    @Param("projectId") projectId: string
  ) {
    return {
      scans: await this.securityScanService.listScans(req.user!, projectId),
    };
  }

  @Get(":projectId/security-scans/:scanId")
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
