import { Body, Controller, Get, Param, Patch, Post, Req, Res, UseGuards } from "@nestjs/common";
import { Request, Response } from "express";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";
import { ExecuteAdminCleanupDto } from "./dto/execute-admin-cleanup.dto";
import { ExecuteDestroyDto } from "./dto/execute-destroy.dto";
import { InfrastructureLifecycleService } from "./infrastructure-lifecycle.service";
import { UpdateEnvironmentTtlDto } from "./dto/update-environment-ttl.dto";

@Controller("api/projects/:projectId")
@UseGuards(requireRole([UserRole.ADMIN]))
export class ProjectResourcesController {
  constructor(private readonly service: InfrastructureLifecycleService) {}
  @Get("resources") resources(@Req() req: Request, @Param("projectId") projectId: string) { return this.service.projectResources(req.user!, projectId); }
  @Post("resources/refresh") refresh(@Req() req: Request, @Param("projectId") projectId: string) { return this.service.refreshProjectResources(req.user!, projectId); }
  @Patch("resources/ttl") ttl(@Req() req: Request, @Param("projectId") projectId: string, @Body() dto: UpdateEnvironmentTtlDto) { return this.service.updateTtl(req.user!, projectId, dto, req); }
  @Post("destroy") destroy(@Req() req: Request, @Param("projectId") projectId: string, @Body() dto: ExecuteDestroyDto) { return this.service.execute(req.user!, projectId, dto, req); }
  @Post("cleanup-selected") cleanup(@Req() req: Request, @Param("projectId") projectId: string, @Body() dto: ExecuteAdminCleanupDto) { return this.service.executeCleanup(req.user!, projectId, dto, req); }
  @Get("cleanup-report") async report(@Req() req: Request, @Param("projectId") projectId: string, @Res() response: Response) { const report = await this.service.projectCleanupReport(req.user!, projectId); response.setHeader("Content-Type", "text/csv; charset=utf-8"); response.setHeader("Content-Disposition", `attachment; filename="${report.filename}"`); response.send(report.csv); }
}
