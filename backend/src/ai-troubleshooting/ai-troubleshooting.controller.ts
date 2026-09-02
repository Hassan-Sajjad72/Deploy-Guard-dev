import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { requireRole } from "../common/rbac/require-role.guard";
import { User, UserRole } from "../users/user.entity";
import { AiTroubleshootingService } from "./ai-troubleshooting.service";
import { FollowUpDto } from "./dto/follow-up.dto";
import { StartAnalysisDto } from "./dto/start-analysis.dto";

@Controller("api/projects/:projectId/troubleshooting")
@UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER]))
export class AiTroubleshootingController {
  constructor(private readonly service: AiTroubleshootingService) {}
  @Get("provider-status") status(@Req() req: Request & { user: User }, @Param("projectId", ParseUUIDPipe) projectId: string) { return this.service.providerStatus(req.user, projectId); }
  @Post() start(@Req() req: Request & { user: User }, @Param("projectId", ParseUUIDPipe) projectId: string, @Body() dto: StartAnalysisDto) { return this.service.start(req.user, projectId, dto.pipelineRunId, dto.serviceId); }
  @Get() list(@Req() req: Request & { user: User }, @Param("projectId", ParseUUIDPipe) projectId: string, @Query("page") page?: string, @Query("limit") limit?: string) { return this.service.list(req.user, projectId, optionalPositiveInteger(page), optionalPositiveInteger(limit)); }
  @Get(":sessionId") get(@Req() req: Request & { user: User }, @Param("projectId", ParseUUIDPipe) projectId: string, @Param("sessionId", ParseUUIDPipe) sessionId: string) { return this.service.get(req.user, projectId, sessionId); }
  @Post(":sessionId/regenerate") regenerate(@Req() req: Request & { user: User }, @Param("projectId", ParseUUIDPipe) projectId: string, @Param("sessionId", ParseUUIDPipe) sessionId: string) { return this.service.regenerate(req.user, projectId, sessionId); }
  @Post(":sessionId/follow-up") followUp(@Req() req: Request & { user: User }, @Param("projectId", ParseUUIDPipe) projectId: string, @Param("sessionId", ParseUUIDPipe) sessionId: string, @Body() dto: FollowUpDto) { return this.service.followUp(req.user, projectId, sessionId, dto.message, dto.questionType); }
  @Delete(":sessionId") close(@Req() req: Request & { user: User }, @Param("projectId", ParseUUIDPipe) projectId: string, @Param("sessionId", ParseUUIDPipe) sessionId: string) { return this.service.close(req.user, projectId, sessionId); }
}

function optionalPositiveInteger(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
