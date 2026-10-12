import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";
import { ProposeRepairDto, RecoveryDecisionDto, RecoveryExecutionDto, RequestRecoveryDto } from "./recovery.dto";
import { RecoveryService } from "./recovery.service";
import { RepairService } from "./repair.service";
@Controller("api/projects/:projectId/recovery")
@UseGuards(requireRole([UserRole.DEVELOPER, UserRole.READONLY]))
export class RecoveryController {
  constructor(private readonly recovery: RecoveryService, private readonly repair: RepairService) {}
  @Get("runbooks") registry(@Req() req: Request, @Param("projectId", ParseUUIDPipe) projectId: string) { return this.recovery.registry(req.user!, projectId); }
  @Get("requests") list(@Req() req: Request, @Param("projectId", ParseUUIDPipe) projectId: string) { return this.recovery.list(req.user!, projectId); }
  @Post("requests") request(@Req() req: Request, @Param("projectId", ParseUUIDPipe) projectId: string, @Body() body: RequestRecoveryDto) { return this.recovery.request(req.user!, projectId, body); }
  @Post("requests/:id/decisions") decide(@Req() req: Request, @Param("projectId", ParseUUIDPipe) projectId: string, @Param("id", ParseUUIDPipe) id: string, @Body() body: RecoveryDecisionDto) { return this.recovery.decide(req.user!, projectId, id, body); }
  @Post("requests/:id/execute") execute(@Req() req: Request, @Param("projectId", ParseUUIDPipe) projectId: string, @Param("id", ParseUUIDPipe) id: string, @Body() body: RecoveryExecutionDto) { return this.recovery.execute(req.user!, projectId, id, body.fingerprint); }
  @Get("requests/:id") verify(@Req() req: Request, @Param("projectId", ParseUUIDPipe) projectId: string, @Param("id", ParseUUIDPipe) id: string) { return this.recovery.verify(req.user!, projectId, id); }
  @Get("repairs") repairs(@Req() req: Request, @Param("projectId", ParseUUIDPipe) projectId: string) { return this.repair.list(req.user!, projectId); }
  @Post("repairs") propose(@Req() req: Request, @Param("projectId", ParseUUIDPipe) projectId: string, @Body() body: ProposeRepairDto) { return this.repair.propose(req.user!, projectId, body); }
  @Post("repairs/:id/check") check(@Req() req: Request, @Param("projectId", ParseUUIDPipe) projectId: string, @Param("id", ParseUUIDPipe) id: string, @Body() body: RecoveryExecutionDto) { return this.repair.check(req.user!, projectId, id, body.fingerprint); }
  @Post("repairs/:id/publish") publish(@Req() req: Request, @Param("projectId", ParseUUIDPipe) projectId: string, @Param("id", ParseUUIDPipe) id: string, @Body() body: RecoveryExecutionDto) { return this.repair.publish(req.user!, projectId, id, body.fingerprint); }
}
