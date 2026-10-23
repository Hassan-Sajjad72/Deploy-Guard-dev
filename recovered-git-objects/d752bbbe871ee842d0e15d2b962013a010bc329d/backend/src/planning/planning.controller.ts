import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";
import { RailpackDeploymentService } from "../projects/railpack-deployment.service";
import { CreateCustomerLifecyclePlanDto, ExecuteDeploymentPlanDto, CreateDeploymentPlanDto, DeploymentPlanDecisionDto, InterpretDeploymentGoalDto } from "./planning.dto";
import { PlanningService } from "./planning.service";

@Controller("api/projects/:projectId")
@UseGuards(requireRole([UserRole.DEVELOPER, UserRole.READONLY]))
export class PlanningController {
  constructor(private readonly planning: PlanningService, private readonly execution: RailpackDeploymentService) {}
  @Post("deployment-goals/interpret") async interpret(@Req() req: Request, @Param("projectId", ParseUUIDPipe) id: string, @Body() dto: InterpretDeploymentGoalDto) { return this.planning.interpretGoal(req.user!, id, dto.prompt); }
  @Get("hosting-profiles") async catalog(@Req() req: Request, @Param("projectId", ParseUUIDPipe) id: string, @Query("region") region?: string) { return this.planning.catalog(req.user!, id, region || ""); }
  @Get("deployment-plans") async list(@Req() req: Request, @Param("projectId", ParseUUIDPipe) id: string) { return { plans: await this.planning.list(req.user!, id) }; }
  @Post("deployment-plans") async create(@Req() req: Request, @Param("projectId", ParseUUIDPipe) id: string, @Body() dto: CreateDeploymentPlanDto) { return { plan: await this.planning.create(req.user!, id, dto) }; }
  @Post("deployment-plans/lifecycle") async lifecycle(@Req() req: Request, @Param("projectId", ParseUUIDPipe) id: string, @Body() dto: CreateCustomerLifecyclePlanDto) { return { plan: await this.planning.createLifecycle(req.user!, id, dto) }; }
  @Get("deployment-plans/:planId") async get(@Req() req: Request, @Param("projectId", ParseUUIDPipe) id: string, @Param("planId", ParseUUIDPipe) planId: string) { return this.planning.get(req.user!, id, planId); }
  @Post("deployment-plans/:planId/execute") async execute(@Req() req: Request, @Param("projectId", ParseUUIDPipe) id: string, @Param("planId", ParseUUIDPipe) planId: string, @Body() dto: ExecuteDeploymentPlanDto) { return this.execution.deployApproved(req.user!, id, planId, dto.fingerprint); }
  @Post("deployment-plans/:planId/decisions") async decide(@Req() req: Request, @Param("projectId", ParseUUIDPipe) id: string, @Param("planId", ParseUUIDPipe) planId: string, @Body() dto: DeploymentPlanDecisionDto) { return { decision: await this.planning.decide(req.user!, id, planId, dto) }; }
}
