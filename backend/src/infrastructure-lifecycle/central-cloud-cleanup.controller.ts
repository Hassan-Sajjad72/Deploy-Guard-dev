import { Body, Controller, Get, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { Request, Response } from "express";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";
import { CentralCloudCleanupService } from "./central-cloud-cleanup.service";
import { CentralCloudInventoryService } from "./central-cloud-inventory.service";
import { EmergencyCleanupService } from "./emergency-cleanup.service";
import { CentralCloudResourceQueryDto, ExecuteCentralCleanupDto, IssueCentralCleanupChallengeDto, MarkCentralManualReviewDto, MarkProjectCleanupCompleteDto, RetryCentralProjectDestroyDto } from "./dto/central-cloud-cleanup.dto";

@Controller("api/admin/cloud-cleanup")
@UseGuards(requireRole([UserRole.ADMIN]))
export class CentralCloudCleanupController {
  constructor(private readonly inventory: CentralCloudInventoryService, private readonly cleanup: CentralCloudCleanupService, private readonly emergency: EmergencyCleanupService) {}

  @Get("summary") summary() { return this.inventory.summary(); }
  @Get("resources") resources(@Query() query: CentralCloudResourceQueryDto) { return this.inventory.resources(query); }
  @Post("refresh") refresh(@Req() req: Request) { return this.inventory.refresh(req.user!, req); }
  @Post("challenge") challenge(@Req() req: Request, @Body() dto: IssueCentralCleanupChallengeDto) { return this.cleanup.issueChallenge(req.user!, dto.action, req); }
  @Post("cleanup-selected") cleanupSelected(@Req() req: Request, @Body() dto: ExecuteCentralCleanupDto) { return this.cleanup.cleanupSelected(req.user!, dto, req); }
  @Post("cleanup-safe-orphans") cleanupSafeOrphans(@Req() req: Request, @Body() dto: ExecuteCentralCleanupDto) { return this.cleanup.cleanupSafeOrphans(req.user!, dto, req); }
  @Post("retry-project-destroy") retryProjectDestroy(@Req() req: Request, @Body() dto: RetryCentralProjectDestroyDto) { return this.cleanup.retryProjectDestroy(req.user!, dto.projectId, dto.operationId); }
  @Post("manual-review") manualReview(@Req() req: Request, @Body() dto: MarkCentralManualReviewDto) { return this.inventory.markManualReview(dto.resourceIds, req.user!, req); }
  @Post("mark-project-complete") markProjectComplete(@Req() req: Request, @Body() dto: MarkProjectCleanupCompleteDto) { return this.inventory.markProjectCleanupComplete(dto.projectId, req.user!, req); }
  @Get("emergency/preview") emergencyPreview() { return this.emergency.preview(); }
  @Get("emergency/operations") emergencyOperations() { return this.emergency.list(); }
  @Post("emergency/challenge") emergencyChallenge(@Req() req: Request) { return this.cleanup.issueChallenge(req.user!, "emergency_non_production", req); }
  @Post("emergency/execute") emergencyExecute(@Req() req: Request, @Body() dto: ExecuteCentralCleanupDto) { return this.emergency.start(req.user!, dto, req); }
  @Get("report") async report(@Res() response: Response) { const report = await this.cleanup.report(); response.setHeader("Content-Type", "text/csv; charset=utf-8"); response.setHeader("Content-Disposition", `attachment; filename="${report.filename}"`); response.send(report.csv); }
}
