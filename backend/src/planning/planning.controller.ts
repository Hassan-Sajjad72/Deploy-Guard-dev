import { Body, Controller, Get, Param, ParseUUIDPipe, ParseEnumPipe, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";
import { RailpackDeploymentService } from "../projects/railpack-deployment.service";
import { CreateCustomerRetryPlanDto, CreateCustomerLifecyclePlanDto, ExecuteDeploymentPlanDto, CreateDeploymentPlanDto, DeploymentPlanDecisionDto, InterpretDeploymentGoalDto, RetainedGenerationActionDto, CreateHostingBuildDto } from "./planning.dto";
import { PlanningService } from "./planning.service";
import { HostingProviderAdapterService } from "./hosting-provider-adapter.service";
import { HostingBuildService } from "./hosting-build.service";

@Controller("api/projects/:projectId")
@UseGuards(requireRole([UserRole.DEVELOPER, UserRole.READONLY]))
export class PlanningController {
  constructor(private readonly planning: PlanningService, private readonly execution: RailpackDeploymentService, private readonly providers: HostingProviderAdapterService, private readonly builds: HostingBuildService) {}
  @Post("hosting-builds") async build(@Req() req: Request, @Param("projectId", ParseUUIDPipe) id: string, @Body() dto: CreateHostingBuildDto) { return { build: await this.builds.build(req.user!, id, dto) }; }
  @Get("hosting-builds/:buildId") async buildRecord(@Req() req: Request, @Param("projectId", ParseUUIDPipe) id: string, @Param("buildId", ParseUUIDPipe) buildId: string) { return { build: await this.builds.get(req.user!, id, buildId) }; }
  @Post("deployment-goals/interpret") async interpret(@Req() req: Request, @Param("projectId", ParseUUIDPipe) id: string, @Body() dto: InterpretDeploymentGoalDto) { return this.planning.interpretGoal(req.user!, id, dto.prompt); }
  @Get("hosting-profiles") async catalog(@Req() req: Request, @Param("projectId", ParseUUIDPipe) id: string, @Query("region") region?: string) { return this.planning.catalog(req.user!, id, region || ""); }
  @Get("deployment-plans") async list(@Req() req: Request, @Param("projectId", ParseUUIDPipe) id: string) { return { plans: await this.planning.list(req.user!, id) }; }
  @Post("deployment-plans") async create(@Req() req: Request, @Param("projectId", ParseUUIDPipe) id: string, @Body() dto: CreateDeploymentPlanDto) { return { plan: await this.planning.create(req.user!, id, dto) }; }
  @Post("deployment-plans/lifecycle") async lifecycle(@Req() req: Request, @Param("projectId", ParseUUIDPipe) id: string, @Body() dto: CreateCustomerLifecyclePlanDto) { return { plan: await this.planning.createLifecycle(req.user!, id, dto) }; }
  @Post("deployment-plans/retry") async retry(@Req() req: Request, @Param("projectId", ParseUUIDPipe) id: string, @Body() dto: CreateCustomerRetryPlanDto) { return { plan: await this.planning.createRetry(req.user!, id, dto) }; }
  @Get("deployment-plans/:planId") async get(@Req() req: Request, @Param("projectId", ParseUUIDPipe) id: string, @Param("planId", ParseUUIDPipe) planId: string) { return this.planning.get(req.user!, id, planId); }
  @Post("deployment-plans/:planId/execute") async execute(@Req() req: Request, @Param("projectId", ParseUUIDPipe) id: string, @Param("planId", ParseUUIDPipe) planId: string, @Body() dto: ExecuteDeploymentPlanDto) {
    // ECS Fargate keeps the existing customer workflow; budget profiles use the sealed provider adapter.
    const { plan } = await this.planning.get(req.user!, id, planId);
    if (plan.content.selectedProfile === "ecs_fargate") return this.execution.deployApproved(req.user!, id, planId, dto.fingerprint);
    return this.providers.execute(req.user!, id, planId, dto.fingerprint);
  }
  @Get("deployment-plans/:planId/provider-artifacts") async artifacts(@Req() req: Request, @Param("projectId", ParseUUIDPipe) id: string, @Param("planId", ParseUUIDPipe) planId: string) { return this.providers.preview(req.user!, id, planId); }
  @Get("provider-runtime") async runtime(@Req() req: Request, @Param("projectId", ParseUUIDPipe) id: string) { return this.providers.observe(req.user!, id); }
  @Get("provider-generations") async generations(@Req() req: Request, @Param("projectId", ParseUUIDPipe) id: string) { return this.providers.list(req.user!, id); }
  @Post("provider-generations/:generationId/:action") async retained(@Req() req: Request, @Param("projectId", ParseUUIDPipe) id: string, @Param("generationId", ParseUUIDPipe) generationId: string, @Param("action", new ParseEnumPipe({ rollback: "rollback", cleanup: "cleanup" })) action: "rollback" | "cleanup", @Body() dto: RetainedGenerationActionDto) { return this.providers.retainedAction(req.user!, id, generationId, action, dto.artifactFingerprint, dto.reason); }
  @Post("deployment-plans/:planId/decisions") async decide(@Req() req: Request, @Param("projectId", ParseUUIDPipe) id: string, @Param("planId", ParseUUIDPipe) planId: string, @Body() dto: DeploymentPlanDecisionDto) { return { decision: await this.planning.decide(req.user!, id, planId, dto) }; }
}
