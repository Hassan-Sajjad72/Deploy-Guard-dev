import { Body, Controller, Delete, Get, Param, ParseIntPipe, ParseUUIDPipe, Post, Put, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";
import { AgencyRecordNameDto, ArchiveAgencyRecordDto, CreateEngagementDto, CreateWorkspaceDto, SetMembershipDto } from "./workspace.dto";
import { WorkspacesService } from "./workspaces.service";
import { AwsAccountBindingsService } from "./aws-account-bindings.service";
import { CreateAwsAccountBindingDto } from "./aws-account-binding.dto";

@Controller("api/workspaces")
@UseGuards(requireRole([UserRole.DEVELOPER, UserRole.READONLY]))
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService, private readonly bindings: AwsAccountBindingsService) {}
  @Get() async list(@Req() req: Request) { return { workspaces: await this.workspaces.list(req.user!) }; }
  @Post() async create(@Req() req: Request, @Body() dto: CreateWorkspaceDto) { return { workspace: await this.workspaces.create(req.user!, dto) }; }
  @Get(":id/members") async members(@Req() req: Request, @Param("id", ParseUUIDPipe) id: string) { return { members: await this.workspaces.members(req.user!, id) }; }
  @Put(":id/members") async setMember(@Req() req: Request, @Param("id", ParseUUIDPipe) id: string, @Body() dto: SetMembershipDto) { await this.workspaces.setMember(req.user!, id, dto); return { updated: true }; }
  @Delete(":id/members/:userId") async removeMember(@Req() req: Request, @Param("id", ParseUUIDPipe) id: string, @Param("userId", ParseIntPipe) userId: number) { await this.workspaces.removeMember(req.user!, id, userId); return { removed: true }; }
  @Get(":id/aws-bindings") async listBindings(@Req() req: Request, @Param("id", ParseUUIDPipe) id: string) { return { bindings: await this.bindings.list(req.user!, id) }; }
  @Post(":id/aws-bindings") async createBinding(@Req() req: Request, @Param("id", ParseUUIDPipe) id: string, @Body() dto: CreateAwsAccountBindingDto) { return this.bindings.create(req.user!, id, dto); }
  @Get(":id/aws-bindings/:bindingId/trust-policy") async trustPolicy(@Req() req: Request, @Param("id", ParseUUIDPipe) id: string, @Param("bindingId", ParseUUIDPipe) bindingId: string) { return { trustPolicy: await this.bindings.onboardingPolicy(req.user!, id, bindingId) }; }
  @Post(":id/aws-bindings/:bindingId/verify") async verifyBinding(@Req() req: Request, @Param("id", ParseUUIDPipe) id: string, @Param("bindingId", ParseUUIDPipe) bindingId: string) { return this.bindings.verify(req.user!, id, bindingId); }
  @Delete(":id/aws-bindings/:bindingId") async revokeBinding(@Req() req: Request, @Param("id", ParseUUIDPipe) id: string, @Param("bindingId", ParseUUIDPipe) bindingId: string) { await this.bindings.revoke(req.user!, id, bindingId); return { revoked: true }; }
  @Get(":id/portfolio") async portfolio(@Req() req: Request, @Param("id", ParseUUIDPipe) id: string) { return this.workspaces.portfolio(req.user!, id); }
  @Post(":id/clients") async createClient(@Req() req: Request, @Param("id", ParseUUIDPipe) id: string, @Body() dto: AgencyRecordNameDto) { return { client: await this.workspaces.createClient(req.user!, id, dto) }; }
  @Post(":id/clients/:clientId/engagements") async createEngagement(@Req() req: Request, @Param("id", ParseUUIDPipe) id: string, @Param("clientId", ParseUUIDPipe) clientId: string, @Body() dto: CreateEngagementDto) { return { engagement: await this.workspaces.createEngagement(req.user!, id, clientId, dto) }; }
  @Put(":id/clients/:recordId") async renameClient(@Req() req: Request, @Param("id", ParseUUIDPipe) id: string, @Param("recordId", ParseUUIDPipe) recordId: string, @Body() dto: AgencyRecordNameDto) { await this.workspaces.updateAgencyRecord(req.user!, id, recordId, "client", dto); return { updated: true }; }
  @Post(":id/clients/:recordId/archive") async archiveClient(@Req() req: Request, @Param("id", ParseUUIDPipe) id: string, @Param("recordId", ParseUUIDPipe) recordId: string, @Body() dto: ArchiveAgencyRecordDto) { await this.workspaces.updateAgencyRecord(req.user!, id, recordId, "client", dto); return { archived: true }; }
  @Put(":id/engagements/:recordId") async renameEngagement(@Req() req: Request, @Param("id", ParseUUIDPipe) id: string, @Param("recordId", ParseUUIDPipe) recordId: string, @Body() dto: AgencyRecordNameDto) { await this.workspaces.updateAgencyRecord(req.user!, id, recordId, "engagement", dto); return { updated: true }; }
  @Post(":id/engagements/:recordId/archive") async archiveEngagement(@Req() req: Request, @Param("id", ParseUUIDPipe) id: string, @Param("recordId", ParseUUIDPipe) recordId: string, @Body() dto: ArchiveAgencyRecordDto) { await this.workspaces.updateAgencyRecord(req.user!, id, recordId, "engagement", dto); return { archived: true }; }
}
