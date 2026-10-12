import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";
import { OrganizationLimitsService } from "./organization-limits.service";
import { PublishOrganizationLimitsDto } from "./organization-limits.dto";
@Controller("api/workspaces/:organizationId/entitlements")
@UseGuards(requireRole([UserRole.DEVELOPER,UserRole.READONLY]))
export class OrganizationLimitsController {
  constructor(private readonly limits: OrganizationLimitsService) {}
  @Get() view(@Req() req: Request,@Param("organizationId",ParseUUIDPipe) id: string) { return this.limits.view(req.user!, id); }
}
@Controller("api/admin/organizations/:organizationId/entitlements")
@UseGuards(requireRole([UserRole.ADMIN]))
export class AdminOrganizationLimitsController {
  constructor(private readonly limits: OrganizationLimitsService) {}
  @Get() view(@Req() req: Request,@Param("organizationId",ParseUUIDPipe) id: string) { return this.limits.view(req.user!, id, true); }
  @Post() publish(@Req() req: Request,@Param("organizationId",ParseUUIDPipe) id: string,@Body() input: PublishOrganizationLimitsDto) { return this.limits.publish(req.user!, id, input); }
}
