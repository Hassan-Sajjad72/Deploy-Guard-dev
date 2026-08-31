import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { SubscribeNotificationDto, UpdateNotificationPreferencesDto } from "./dto/update-notification-preferences.dto";
import { NotificationsService } from "./notifications.service";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";

@Controller("api/projects/:projectId/notifications")
@UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER, UserRole.READONLY]))
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}
  @Get() get(@Req() req: Request, @Param("projectId", ParseUUIDPipe) projectId: string) { return this.service.settings(req.user!, projectId); }
  @Patch("preferences") update(@Req() req: Request, @Param("projectId", ParseUUIDPipe) projectId: string, @Body() dto: UpdateNotificationPreferencesDto) { return this.service.update(req.user!, projectId, dto, req); }
  @Post("subscribe") subscribe(@Req() req: Request, @Param("projectId", ParseUUIDPipe) projectId: string, @Body() dto: SubscribeNotificationDto) { return this.service.subscribe(req.user!, projectId, dto.email, req); }
  @Post("refresh-status") refresh(@Req() req: Request, @Param("projectId", ParseUUIDPipe) projectId: string) { return this.service.refreshStatus(req.user!, projectId); }
  @Post("resend-confirmation") resend(@Req() req: Request, @Param("projectId", ParseUUIDPipe) projectId: string) { return this.service.resendConfirmation(req.user!, projectId, req); }
  @Post("unsubscribe") unsubscribe(@Req() req: Request, @Param("projectId", ParseUUIDPipe) projectId: string) { return this.service.unsubscribe(req.user!, projectId, req); }
  @Post("test") test(@Req() req: Request, @Param("projectId", ParseUUIDPipe) projectId: string) { return this.service.test(req.user!, projectId); }
}
