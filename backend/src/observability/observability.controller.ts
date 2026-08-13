import { BadRequestException, Controller, Get, Param, Query, Req, Res, UseGuards } from "@nestjs/common";
import { Request, Response } from "express";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";
import { LogQueryOptions } from "./cloudwatch-logs.service";
import { ObservabilityService } from "./observability.service";
import { SseLogStreamService } from "./sse-log-stream.service";

@Controller("api/projects/:projectId/observability")
@UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER, UserRole.READONLY]))
export class ObservabilityController {
  constructor(
    private readonly observabilityService: ObservabilityService,
    private readonly sseLogStreamService: SseLogStreamService
  ) {}

  @Get("summary")
  @UseGuards(requireRole([UserRole.ADMIN]))
  summary(@Req() req: Request, @Param("projectId") projectId: string) {
    return this.observabilityService.getSummary(req.user!, projectId);
  }

  @Get("pipeline-metrics")
  @UseGuards(requireRole([UserRole.ADMIN]))
  pipelineMetrics(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Query("pipelineRunId") pipelineRunId?: string
  ) {
    return this.observabilityService.getPipelineMetrics(req.user!, projectId, pipelineRunId);
  }

  @Get("runtime-metrics")
  @UseGuards(requireRole([UserRole.ADMIN]))
  runtimeMetrics(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Query("source") source = "auto",
    @Query("range") range = "1h"
  ) {
    return this.observabilityService.getRuntimeMetrics(req.user!, projectId, source, range);
  }

  @Get("logs")
  @UseGuards(requireRole([UserRole.ADMIN]))
  logs(@Req() req: Request, @Param("projectId") projectId: string, @Query() query: LogQueryOptions) {
    return this.observabilityService.getLogs(req.user!, projectId, this.normalizeLogQuery(query));
  }

  @Get("logs/stream")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async streamLogs(
    @Req() req: Request,
    @Res() response: Response,
    @Param("projectId") projectId: string,
    @Query() query: LogQueryOptions
  ) {
    await this.observabilityService.findProjectForView(req.user!, projectId);
    return this.sseLogStreamService.stream(projectId, this.normalizeLogQuery(query), response, req.user!);
  }

  @Get("health")
  @UseGuards(requireRole([UserRole.ADMIN]))
  health(@Req() req: Request, @Param("projectId") projectId: string) {
    return this.observabilityService.getHealth(req.user!, projectId);
  }

  @Get("application-metrics")
  applicationMetrics(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Query("range") range = "1h",
  ) {
    if (!["1h", "6h", "24h"].includes(range)) {
      throw new BadRequestException("Unsupported metrics time range.");
    }
    return this.observabilityService.getApplicationMetrics(req.user!, projectId, range);
  }

  @Get("application-logs")
  applicationLogs(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Query("limit") limitValue = "50",
    @Query("since") since?: string,
  ) {
    const limit = Number(limitValue);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException("Log limit must be between 1 and 100.");
    }
    if (since && Number.isNaN(Date.parse(since))) {
      throw new BadRequestException("Invalid log start time.");
    }
    return this.observabilityService.getApplicationLogs(req.user!, projectId, { limit, since });
  }

  private normalizeLogQuery(query: LogQueryOptions): LogQueryOptions {
    return {
      ...query,
      limit: query.limit ? Number(query.limit) : undefined,
      stream: query.stream || "all",
    };
  }
}
