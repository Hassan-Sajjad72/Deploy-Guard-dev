import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";
import { AuditLogService } from "./audit-log.service";
import { AuditLogQueryDto } from "./dto/audit-log-query.dto";

@Controller("api/audit-logs")
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @Get()
  @UseGuards(requireRole([UserRole.ADMIN]))
  async listAuditLogs(@Query() query: AuditLogQueryDto, @Req() req: Request) {
    return this.auditLogService.findForUser(req.user!, query);
  }
}
