import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";
import { StateManagementService } from "./state-management.service";

@Controller("api/projects/:projectId/state")
@UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER, UserRole.READONLY]))
export class StateManagementController {
  constructor(private readonly stateManagementService: StateManagementService) {}

  @Get()
  async getState(@Req() req: Request, @Param("projectId") projectId: string) {
    return { state: await this.stateManagementService.getState(req.user!, projectId) };
  }

  @Get("versions")
  async getVersions(@Req() req: Request, @Param("projectId") projectId: string) {
    return { versions: await this.stateManagementService.getVersions(req.user!, projectId) };
  }

  @Get("locks")
  async getLocks(@Req() req: Request, @Param("projectId") projectId: string) {
    return this.stateManagementService.getLocks(req.user!, projectId);
  }

  @Get("validation")
  async getValidation(@Req() req: Request, @Param("projectId") projectId: string) {
    return {
      results: await this.stateManagementService.getValidationResults(req.user!, projectId),
    };
  }

  @Post("validate")
  async validate(@Req() req: Request, @Param("projectId") projectId: string) {
    return { result: await this.stateManagementService.validate(req.user!, projectId) };
  }

  @Post("recover")
  async recover(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Body() dto: Record<string, unknown>
  ) {
    return { recovery: await this.stateManagementService.recover(req.user!, projectId, dto) };
  }

  @Post("locks/:lockId/force-release")
  async forceRelease(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Param("lockId") lockId: string
  ) {
    return {
      lock: await this.stateManagementService.forceRelease(req.user!, projectId, lockId),
    };
  }
}
