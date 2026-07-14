import { Body, Controller, Get, Headers, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";
import { OrchestrationService } from "./orchestration.service";

@Controller("api/projects/:projectId/orchestration")
export class OrchestrationController {
  constructor(private readonly orchestrationService: OrchestrationService) {}

  @Post("deploy")
  @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER]))
  async deploy(@Req() req: Request, @Param("projectId") projectId: string) {
    return this.orchestrationService.deploy(req.user!, projectId, req);
  }

  @Get("status")
  @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER, UserRole.READONLY]))
  async status(@Req() req: Request, @Param("projectId") projectId: string) {
    return this.orchestrationService.getStatus(req.user!, projectId);
  }

  @Get("events")
  @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER, UserRole.READONLY]))
  async events(@Req() req: Request, @Param("projectId") projectId: string) {
    return {
      events: await this.orchestrationService.getEvents(req.user!, projectId),
    };
  }

  @Get("releases")
  @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER, UserRole.READONLY]))
  async releases(@Req() req: Request, @Param("projectId") projectId: string) {
    return {
      releases: await this.orchestrationService.getReleases(req.user!, projectId),
    };
  }

  @Post("rollback")
  @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER]))
  async rollback(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Body() dto: { reason?: string }
  ) {
    return this.orchestrationService.rollback(req.user!, projectId, dto, req);
  }

  @Get("target-health")
  @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER, UserRole.READONLY]))
  async targetHealth(@Req() req: Request, @Param("projectId") projectId: string) {
    return {
      targetHealth: await this.orchestrationService.getTargetHealth(req.user!, projectId),
    };
  }

  @Get("scaling")
  @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER, UserRole.READONLY]))
  async scaling(@Req() req: Request, @Param("projectId") projectId: string) {
    return {
      scaling: await this.orchestrationService.getScaling(req.user!, projectId),
    };
  }

  @Patch("scaling")
  @UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER]))
  async updateScaling(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Body() dto: { minTasks?: number; maxTasks?: number; cpuTargetPercent?: number }
  ) {
    return {
      scaling: await this.orchestrationService.updateScaling(req.user!, projectId, dto, req),
    };
  }

  @Post("spot-event")
  async spotEvent(
    @Param("projectId") projectId: string,
    @Headers("x-deployguard-spot-secret") secret: string | undefined,
    @Body() event: Record<string, unknown>
  ) {
    return {
      event: await this.orchestrationService.handleSpotEvent(projectId, event, secret || null),
    };
  }
}
