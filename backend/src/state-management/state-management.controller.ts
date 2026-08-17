import { Body, Controller, Get, Header, Param, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";
import { StateManagementService } from "./state-management.service";

@Controller("api/projects/:projectId/state")
@UseGuards(requireRole([UserRole.ADMIN]))
export class StateManagementController {
  constructor(private readonly stateManagementService: StateManagementService) {}

  @Get()
  @Header("Cache-Control", "private, no-store")
  async getState(@Req() req: Request, @Param("projectId") projectId: string) {
    return { state: await this.stateManagementService.getState(req.user!, projectId) };
  }

  @Get("safety-snapshot")
  @Header("Cache-Control", "private, no-store")
  async getSafetySnapshot(@Req() req: Request, @Param("projectId") projectId: string) {
    return { snapshot: await this.stateManagementService.getSafetySnapshot(req.user!, projectId) };
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
  @UseGuards(requireRole([UserRole.ADMIN]))
  async validate(@Req() req: Request, @Param("projectId") projectId: string) {
    const result = await this.stateManagementService.validate(req.user!, projectId);
    return { result, snapshot: await this.stateManagementService.getSafetySnapshot(req.user!, projectId) };
  }

  @Post("recover")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async recover(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Body() dto: Record<string, unknown>
  ) {
    const recovery = await this.stateManagementService.recover(req.user!, projectId, dto);
    return { recovery, snapshot: await this.stateManagementService.getSafetySnapshot(req.user!, projectId) };
  }

  @Post("locks/:lockId/force-release")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async forceRelease(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Param("lockId") lockId: string
  ) {
    const lock = await this.stateManagementService.forceRelease(req.user!, projectId, lockId);
    return { lock, snapshot: await this.stateManagementService.getSafetySnapshot(req.user!, projectId) };
  }

  @Post("lockfile/clear-stale")
  @UseGuards(requireRole([UserRole.ADMIN]))
  async clearStaleLockfile(@Req() req: Request, @Param("projectId") projectId: string) {
    const lockfile = await this.stateManagementService.clearStaleLockfile(req.user!, projectId);
    return { lockfile, snapshot: await this.stateManagementService.getSafetySnapshot(req.user!, projectId) };
  }
}
