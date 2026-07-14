import { Controller, Get, Param, Query, Req, Res, UseGuards } from "@nestjs/common";
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
  summary(@Req() req: Request, @Param("projectId") projectId: string) {
    return this.observabilityService.getSummary(req.user!, projectId);
  }

  @Get("pipeline-metrics")
  pipelineMetrics(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Query("pipelineRunId") pipelineRunId?: string
  ) {
    return this.observabilityService.getPipelineMetrics(req.user!, projectId, pipelineRunId);
  }

  @Get("runtime-metrics")
  runtimeMetrics(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Query("source") source = "auto",
    @Query("range") range = "1h"
  ) {
    return this.observabilityService.getRuntimeMetrics(req.user!, projectId, source, range);
  }

  @Get("logs")
  logs(@Req() req: Request, @Param("projectId") projectId: string, @Query() query: LogQueryOptions) {
    return this.observabilityService.getLogs(req.user!, projectId, this.normalizeLogQuery(query));
  }

  @Get("logs/stream")
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
  health(@Req() req: Request, @Param("projectId") projectId: string) {
    return this.observabilityService.getHealth(req.user!, projectId);
  }

  private normalizeLogQuery(query: LogQueryOptions): LogQueryOptions {
    return {
      ...query,
      limit: query.limit ? Number(query.limit) : undefined,
      stream: query.stream || "all",
    };
  }
}
