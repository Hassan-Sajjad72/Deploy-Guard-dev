import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";
import { ExecuteDestroyDto } from "./dto/execute-destroy.dto";
import { InfrastructureLifecycleService } from "./infrastructure-lifecycle.service";
import { IssueDestroyChallengeDto } from "./dto/issue-destroy-challenge.dto";
import { ExecuteAdminCleanupDto } from "./dto/execute-admin-cleanup.dto";
@Controller("api/projects/:projectId/infrastructure/destroy")
@UseGuards(requireRole([UserRole.ADMIN]))
export class InfrastructureLifecycleController {
  constructor(private readonly service: InfrastructureLifecycleService) {}
  @Get("review") review(@Req() req: Request, @Param("projectId") projectId: string, @Query("environment") environment = "dev") { return this.service.review(req.user!, projectId, environment); }
  @Post("challenge") challenge(@Req() req: Request, @Param("projectId") projectId: string, @Body() body: IssueDestroyChallengeDto) { return this.service.issueChallenge(req.user!, projectId, body.environmentName || "dev", req); }
  @Post("request") execute(@Req() req: Request, @Param("projectId") projectId: string, @Body() dto: ExecuteDestroyDto) { return this.service.execute(req.user!, projectId, dto, req); }
  @Get("status") status(@Req() req: Request, @Param("projectId") projectId: string, @Query("operationId") operationId?: string) { return this.service.status(req.user!, projectId, operationId); }
  @Get("inventory") inventory(@Req() req: Request, @Param("projectId") projectId: string) { return this.service.inventory(req.user!, projectId); }
  @Post("cleanup/challenge") cleanupChallenge(@Req() req: Request, @Param("projectId") projectId: string, @Body() body: IssueDestroyChallengeDto) { return this.service.issueCleanupChallenge(req.user!, projectId, body.environmentName || "dev", req); }
  @Post("cleanup") cleanup(@Req() req: Request, @Param("projectId") projectId: string, @Body() dto: ExecuteAdminCleanupDto) { return this.service.executeCleanup(req.user!, projectId, dto, req); }
  @Post(":operationId/cancel") cancel(@Req() req: Request, @Param("projectId") projectId: string, @Param("operationId") operationId: string) { return this.service.cancel(req.user!, projectId, operationId, req); }
  @Post(":operationId/retry") retry(@Req() req: Request, @Param("projectId") projectId: string, @Param("operationId") operationId: string) { return this.service.retry(req.user!, projectId, operationId); }
}
