import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";
import { CreateOrganizationDto, RegisterAwsAccountDto } from "./aws-account.dto";
import { AwsAccountsService } from "./aws-accounts.service";

@Controller("api/organizations")
@UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER, UserRole.READONLY]))
export class AwsAccountsController {
  constructor(private readonly accounts: AwsAccountsService) {}
  @Get() listOrganizations(@Req() req: Request) { return this.accounts.listOrganizations(req.user!.id); }
  @Post() createOrganization(@Req() req: Request, @Body() dto: CreateOrganizationDto) { return this.accounts.createOrganization(req.user!.id, dto); }
  @Get(":organizationId/aws-accounts") list(@Req() req: Request, @Param("organizationId", ParseUUIDPipe) organizationId: string) {
    return this.accounts.list(req.user!.id, organizationId);
  }
  @Post(":organizationId/aws-accounts") register(@Req() req: Request, @Param("organizationId", ParseUUIDPipe) organizationId: string, @Body() dto: RegisterAwsAccountDto) {
    return this.accounts.register(req.user!.id, organizationId, dto);
  }
  @Post(":organizationId/aws-accounts/:bindingId/revoke") revoke(@Req() req: Request,
    @Param("organizationId", ParseUUIDPipe) organizationId: string, @Param("bindingId", ParseUUIDPipe) bindingId: string) {
    return this.accounts.revoke(req.user!.id, organizationId, bindingId);
  }
  @Post(":organizationId/aws-accounts/:bindingId/verify-identity") verifyIdentity(@Req() req: Request,
    @Param("organizationId", ParseUUIDPipe) organizationId: string, @Param("bindingId", ParseUUIDPipe) bindingId: string) {
    return this.accounts.verifyIdentity(req.user!.id, organizationId, bindingId);
  }
}
