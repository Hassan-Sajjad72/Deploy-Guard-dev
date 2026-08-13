import { Controller, Get, Param, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";
import { InfrastructureService } from "./infrastructure.service";

@Controller("api/projects/:projectId")
@UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER, UserRole.READONLY]))
export class InfrastructureController {
  constructor(private readonly infrastructureService: InfrastructureService) {}

  @Get("deployment-readiness")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async getDeploymentReadiness(
    @Req() req: Request,
    @Param("projectId") projectId: string
  ) {
    return this.infrastructureService.getDeploymentReadiness(req.user!, projectId, req);
  }

  @Get("infrastructure")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async getInfrastructure(@Req() req: Request, @Param("projectId") projectId: string) {
    return {
      environment: await this.infrastructureService.getInfrastructureStatus(
        req.user!,
        projectId
      ),
    };
  }

  @Get("infrastructure/events")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async getInfrastructureEvents(
    @Req() req: Request,
    @Param("projectId") projectId: string
  ) {
    return {
      events: await this.infrastructureService.getInfrastructureEvents(
        req.user!,
        projectId
      ),
    };
  }

  @Get("service-discovery")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async getServiceDiscovery(
    @Req() req: Request,
    @Param("projectId") projectId: string
  ) {
    return {
      records: await this.infrastructureService.getServiceDiscoveryInfo(
        req.user!,
        projectId
      ),
    };
  }
}
