import { BadRequestException, Controller, Get, Param, Query, Req, Res, UseGuards } from "@nestjs/common";
import { Request, Response } from "express";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";
import { CloudWatchLogsService } from "./cloudwatch-logs.service";
import { ObservabilityService } from "./observability.service";

@Controller("api/projects/:projectId/observability")
@UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER, UserRole.READONLY]))
export class ObservabilityController {
  constructor(
    private readonly observability: ObservabilityService,
    private readonly logs: CloudWatchLogsService,
  ) {}

  @Get("summary")
  summary(@Req() req: Request, @Param("projectId") projectId: string, @Query("serviceId") serviceId?: string) {
    return this.observability.getSummary(req.user!, projectId, serviceId);
  }

  @Get("application-metrics")
  applicationMetrics(@Req() req: Request, @Param("projectId") projectId: string, @Query("range") range = "1h", @Query("serviceId") serviceId?: string) {
    if (!["1h", "6h", "24h"].includes(range)) throw new BadRequestException("Unsupported metrics time range.");
    return this.observability.getApplicationMetrics(req.user!, projectId, range, serviceId);
  }

  @Get("runtime-metrics")
  runtimeMetrics(@Req() req: Request, @Param("projectId") projectId: string, @Query("range") range = "1h", @Query("serviceId") serviceId?: string) {
    return this.applicationMetrics(req, projectId, range, serviceId);
  }

  @Get("application-logs")
  applicationLogs(@Req() req: Request, @Param("projectId") projectId: string, @Query("limit") limitValue = "200", @Query("since") since?: string, @Query("serviceId") serviceId?: string) {
    const limit = Number(limitValue);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new BadRequestException("Log limit must be between 1 and 500.");
    if (since && Number.isNaN(Date.parse(since))) throw new BadRequestException("Invalid log start time.");
    return this.observability.getApplicationLogs(req.user!, projectId, { limit, since }, serviceId);
  }

  @Get("application-logs/stream")
  streamApplicationLogs(@Req() req: Request, @Res() response: Response, @Param("projectId") projectId: string, @Query("serviceId") serviceId?: string) {
    return this.logs.stream(req.user!, projectId, response, serviceId);
  }

  @Get("logs/stream")
  streamCompatibility(@Req() req: Request, @Res() response: Response, @Param("projectId") projectId: string, @Query("serviceId") serviceId?: string) {
    return this.logs.stream(req.user!, projectId, response, serviceId);
  }

  @Get("health")
  health(@Req() req: Request, @Param("projectId") projectId: string, @Query("serviceId") serviceId?: string) {
    return this.observability.getHealth(req.user!, projectId, serviceId);
  }
}
