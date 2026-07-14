import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";
import { StorageService } from "./storage.service";

@Controller("api/projects/:projectId")
@UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER, UserRole.READONLY]))
export class StorageController {
  constructor(private readonly storageService: StorageService) {}

  @Get("storage/recommendation")
  async getRecommendation(@Req() req: Request, @Param("projectId") projectId: string) {
    return {
      recommendation: await this.storageService.getRecommendation(req.user!, projectId),
    };
  }

  @Get("storage")
  async getStorage(@Req() req: Request, @Param("projectId") projectId: string) {
    return {
      storage: await this.storageService.getStorage(req.user!, projectId),
    };
  }

  @Patch("storage/settings")
  async updateSettings(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Body() dto: { enabled?: boolean; backupEnabled?: boolean }
  ) {
    return {
      storage: await this.storageService.updateSettings(req.user!, projectId, dto, req),
    };
  }

  @Post("storage/provision")
  async provision(@Req() req: Request, @Param("projectId") projectId: string) {
    return this.storageService.provision(req.user!, projectId, req);
  }

  @Get("storage/events")
  async getEvents(@Req() req: Request, @Param("projectId") projectId: string) {
    return {
      events: await this.storageService.getEvents(req.user!, projectId),
    };
  }

  @Get("storage/mount-config")
  async getMountConfig(@Req() req: Request, @Param("projectId") projectId: string) {
    return {
      mountConfig: await this.storageService.getMountConfig(req.user!, projectId),
    };
  }

  @Get("backups")
  async getBackups(@Req() req: Request, @Param("projectId") projectId: string) {
    return {
      backups: await this.storageService.getBackups(req.user!, projectId),
    };
  }

  @Post("backups/restore-request")
  async createRestoreRequest(
    @Req() req: Request,
    @Param("projectId") projectId: string,
    @Body() dto: { persistentStorageId?: string; recoveryPointArn?: string; reason?: string }
  ) {
    return {
      restoreRequest: await this.storageService.createRestoreRequest(
        req.user!,
        projectId,
        dto,
        req
      ),
    };
  }
}
