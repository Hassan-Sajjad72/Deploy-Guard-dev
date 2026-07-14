import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";
import { FinopsService } from "./finops.service";

@Controller("api/projects/:projectId")
@UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER, UserRole.READONLY]))
export class FinopsController {
  constructor(private readonly finopsService: FinopsService) {}

  @Post("cost-estimates")
  async createEstimate(@Req() req: Request, @Param("projectId") projectId: string) {
    return {
      estimate: await this.finopsService.createEstimate(req.user!, projectId, req),
    };
  }

  @Get("cost-estimates")
  async listEstimates(@Req() req: Request, @Param("projectId") projectId: string) {
    return {
      estimates: await this.finopsService.listEstimates(req.user!, projectId),
    };
  }

  @Get("cost-estimates/latest")
  async getLatestEstimate(@Req() req: Request, @Param("projectId") projectId: string) {
    return {
      estimate: await this.finopsService.getLatestEstimate(req.user!, projectId),
    };
  }

  @Get("cost-estimates/:estimateId")
  async getEstimate(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Param("estimateId") estimateId: string
  ) {
    return {
      estimate: await this.finopsService.getEstimate(req.user!, projectId, estimateId),
    };
  }

  @Post("cost-estimates/:estimateId/approve")
  async approveEstimate(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Param("estimateId") estimateId: string
  ) {
    return {
      estimate: await this.finopsService.approveEstimate(
        req.user!,
        projectId,
        estimateId,
        req
      ),
    };
  }

  @Post("cost-estimates/:estimateId/reject")
  async rejectEstimate(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Param("estimateId") estimateId: string,
    @Body() dto: Record<string, unknown>
  ) {
    return {
      estimate: await this.finopsService.rejectEstimate(
        req.user!,
        projectId,
        estimateId,
        dto,
        req
      ),
    };
  }

  @Get("cost-settings")
  async getSettings(@Req() req: Request, @Param("projectId") projectId: string) {
    return {
      settings: await this.finopsService.getSettings(req.user!, projectId),
    };
  }

  @Patch("cost-settings")
  async updateSettings(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Body() dto: Record<string, unknown>
  ) {
    return {
      settings: await this.finopsService.updateSettings(req.user!, projectId, dto, req),
    };
  }
}
