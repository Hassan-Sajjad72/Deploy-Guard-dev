import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
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

@Controller("api/projects")
@UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER, UserRole.READONLY]))
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly deploymentProfileService: DeploymentProfileService,
    private readonly preflightService: PreflightService,
    private readonly pipelineService: PipelineService,
    private readonly securityScanService: SecurityScanService,
    private readonly projectCurrentStateService: ProjectCurrentStateService
  ) {}

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

    return {
      summaries: projects.map((project, index) => ({
        project,
        currentState:
          states[index].status === "fulfilled" ? states[index].value : null,
      })),
    };
  }

  @Get("github/repositories")
  async listGithubRepositories(@Req() req: Request) {
    return { repositories: await this.projectsService.listGithubRepositories(req.user!) };
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
      project: await this.projectsService.createProject(req.user!, dto, req),
    };
  }

  @Post(":projectId/detect-stack")
  async detectStack(@Req() req: Request, @Param("projectId") projectId: string) {
    return {
      profile: await this.deploymentProfileService.runDetection(
        req.user!,
        projectId,
        req
      ),
    };
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
  async getCurrentState(
    @Req() req: Request,
    @Param("projectId") projectId: string
  ) {
    return this.projectCurrentStateService.getCurrentState(req.user!, projectId);
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

    const profile = await this.deploymentProfileService.runDetection(
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
            profile.errors?.[0] ||
            "Stack detection could not produce a deployable application profile.",
        },
      };
    }

    const report = await this.preflightService.generateReport(
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
          "DeployGuard automation is queued. Detection and pre-flight completed automatically.",
      },
    };
  }

  @Post(":projectId/preflight")
  async generatePreflight(
    @Req() req: Request,
    @Param("projectId") projectId: string
  ) {
    return {
      report: await this.preflightService.generateReport(req.user!, projectId, req),
    };
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

  @Post(":projectId/security-scans")
  async triggerSecurityScan(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Body() dto: StartSecurityScanDto
  ) {
    return {
      scan: await this.securityScanService.triggerScan(
        req.user!,
        projectId,
        dto,
        req
      ),
    };
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
    return {
      scan: await this.securityScanService.approveScan(
        req.user!,
        projectId,
        scanId,
        dto,
        req
      ),
    };
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
      project: await this.projectsService.updateProject(req.user!, projectId, dto, req),
    };
  }

  @Delete(":projectId")
  async archiveProject(@Req() req: Request, @Param("projectId") projectId: string) {
    await this.projectsService.archiveProject(req.user!, projectId, req);

    return { message: "Project archived successfully" };
  }

  @Patch(":projectId/repository")
  async updateRepository(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Body() dto: UpdateRepositoryDto
  ) {
    return {
      project: await this.projectsService.updateRepository(
        req.user!,
        projectId,
        dto,
        req
      ),
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
      project: await this.projectsService.updateBranch(req.user!, projectId, dto, req),
    };
  }

  @Get(":projectId/env")
  async listEnvVars(@Req() req: Request, @Param("projectId") projectId: string) {
    return {
      variables: await this.projectsService.listEnvVars(req.user!, projectId),
    };
  }

  @Post(":projectId/env")
  async createEnvVar(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Body() dto: CreateEnvVarDto
  ) {
    return {
      variable: await this.projectsService.createEnvVar(req.user!, projectId, dto, req),
    };
  }

  @Patch(":projectId/env/:envId")
  async updateEnvVar(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Param("envId") envId: string,
    @Body() dto: UpdateEnvVarDto
  ) {
    return {
      variable: await this.projectsService.updateEnvVar(
        req.user!,
        projectId,
        envId,
        dto,
        req
      ),
    };
  }

  @Delete(":projectId/env/:envId")
  async deleteEnvVar(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Param("envId") envId: string
  ) {
    await this.projectsService.deleteEnvVar(req.user!, projectId, envId, req);

    return { message: "Environment variable deleted successfully" };
  }
}
