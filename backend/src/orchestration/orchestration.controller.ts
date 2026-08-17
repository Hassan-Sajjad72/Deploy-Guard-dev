import { Controller, Get, Param, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";
import { OrchestrationService } from "./orchestration.service";

@Controller("api/projects/:projectId/orchestration")
export class OrchestrationController {
  constructor(private readonly orchestrationService: OrchestrationService) {}

  @Get("status")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async status(@Req() req: Request, @Param("projectId") projectId: string) {
    return this.orchestrationService.getStatus(req.user!, projectId);
  }

  @Get("events")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async events(@Req() req: Request, @Param("projectId") projectId: string) {
    return {
      events: await this.orchestrationService.getEvents(req.user!, projectId),
    };
  }

  @Get("releases")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async releases(@Req() req: Request, @Param("projectId") projectId: string) {
    return {
      releases: await this.orchestrationService.getReleases(req.user!, projectId),
    };
  }

  @Get("target-health")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async targetHealth(@Req() req: Request, @Param("projectId") projectId: string) {
    return {
      targetHealth: await this.orchestrationService.getTargetHealth(req.user!, projectId),
    };
  }

  @Get("scaling")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async scaling(@Req() req: Request, @Param("projectId") projectId: string) {
    return {
      scaling: await this.orchestrationService.getScaling(req.user!, projectId),
    };
  }

}
