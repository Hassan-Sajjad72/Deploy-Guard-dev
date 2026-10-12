import { Body, Controller, Param, ParseUUIDPipe, Post, Req, UseGuards } from "@nestjs/common";
import { IsObject, IsString, Matches, MaxLength, MinLength } from "class-validator";
import { Request } from "express";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";
import { CustomerAuthorityService } from "./customer-authority.service";
class ImportCustomerAuthorityDto {
  @IsObject() proof: Record<string, unknown>;
  @IsString() @Matches(/^[0-9a-f]{64}$/) signature: string;
  @IsString() @MinLength(1) @MaxLength(1000) reason: string;
}
@Controller("api/admin/workspaces/:organizationId/aws-bindings/:bindingId")
@UseGuards(requireRole([UserRole.ADMIN]))
export class CustomerAuthorityController {
  constructor(private readonly authority: CustomerAuthorityService) {}
  @Post("final-authority-proof") import(@Req() req: Request, @Param("organizationId", ParseUUIDPipe) organizationId: string, @Param("bindingId", ParseUUIDPipe) bindingId: string, @Body() input: ImportCustomerAuthorityDto) {
    return this.authority.import(req.user!, organizationId, bindingId, input);
  }
}
