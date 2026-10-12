import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";
import { ApproveApiContractDto, CreateOptimizationDto, RegisterApiContractDto } from "./intelligence.dto";
import { IntelligenceService } from "./intelligence.service";
import { AdminAuthorizationService } from "../admin/admin-authorization.service";
import { SupportAccessDto } from "../admin/dto/admin-controls.dto";

@Controller("api/projects/:projectId/intelligence")
@UseGuards(requireRole([UserRole.DEVELOPER, UserRole.READONLY]))
export class IntelligenceController {
  constructor(private readonly intelligence: IntelligenceService) {}
  @Get() list(@Param("projectId", ParseUUIDPipe) projectId: string, @Req() req: Request) { return this.intelligence.list(req.user!, projectId); }
  @Get("records/:id") record(@Param("projectId", ParseUUIDPipe) projectId: string, @Param("id", ParseUUIDPipe) id: string, @Req() req: Request) { return this.intelligence.get(req.user!, projectId, id); }
  @Get("incidents/:id") incidentRecord(@Param("projectId", ParseUUIDPipe) projectId: string, @Param("id", ParseUUIDPipe) id: string, @Req() req: Request) { return this.intelligence.get(req.user!, projectId, id, "incident"); }
  @Post("incidents") incident(@Param("projectId", ParseUUIDPipe) projectId: string, @Req() req: Request) { return this.intelligence.incident(req.user!, projectId); }
  @Post("api-contracts") register(@Param("projectId", ParseUUIDPipe) projectId: string, @Body() input: RegisterApiContractDto, @Req() req: Request) { return this.intelligence.registerContract(req.user!, projectId, input); }
  @Post("api-contracts/:id/approve") approve(@Param("projectId", ParseUUIDPipe) projectId: string, @Param("id", ParseUUIDPipe) id: string, @Body() input: ApproveApiContractDto, @Req() req: Request) { return this.intelligence.approveContract(req.user!, projectId, id, input); }
  @Post("api-contracts/:id/run") run(@Param("projectId", ParseUUIDPipe) projectId: string, @Param("id", ParseUUIDPipe) id: string, @Req() req: Request) { return this.intelligence.runContract(req.user!, projectId, id); }
  @Post("optimizations") optimize(@Param("projectId", ParseUUIDPipe) projectId: string, @Body() input: CreateOptimizationDto, @Req() req: Request) { return this.intelligence.optimize(req.user!, projectId, input); }
}

@Controller("api/workspaces/:organizationId/support-access")
@UseGuards(requireRole([UserRole.DEVELOPER, UserRole.READONLY]))
export class CustomerSupportAccessController {
  constructor(private readonly authorization: AdminAuthorizationService) {}
  @Get() list(@Param("organizationId", ParseUUIDPipe) organizationId: string, @Req() req: Request) { return this.authorization.listSupport(req.user!, organizationId); }
  @Post() grant(@Param("organizationId", ParseUUIDPipe) organizationId: string, @Body() input: SupportAccessDto, @Req() req: Request) { return this.authorization.grantSupport(req.user!, organizationId, input); }
  @Post(":grantId/revoke") revoke(@Param("organizationId", ParseUUIDPipe) organizationId: string, @Param("grantId", ParseUUIDPipe) grantId: string, @Req() req: Request) { return this.authorization.revokeSupport(req.user!, organizationId, grantId); }
}
