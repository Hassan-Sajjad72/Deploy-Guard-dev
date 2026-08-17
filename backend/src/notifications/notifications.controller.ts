import { Body, Controller, Get, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { SubscribeNotificationDto, UpdateNotificationPreferencesDto } from "./dto/update-notification-preferences.dto";
import { NotificationsService } from "./notifications.service";
import { requireRole } from "../common/rbac/require-role.guard";
import { UserRole } from "../users/user.entity";

@Controller("api/projects/:projectId/notifications")
@UseGuards(requireRole([UserRole.ADMIN, UserRole.DEVELOPER, UserRole.READONLY]))
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}
  @Get() get(@Req() req: Request) { return this.service.settings(req.user!, req.params.projectId); }
  @Patch("preferences") update(@Req() req: Request, @Body() dto: UpdateNotificationPreferencesDto) { return this.service.update(req.user!, req.params.projectId, dto, req); }
  @Post("subscribe") subscribe(@Req() req: Request, @Body() dto: SubscribeNotificationDto) { return this.service.subscribe(req.user!, req.params.projectId, dto.email, req); }
  @Post("refresh-status") refresh(@Req() req: Request) { return this.service.refreshStatus(req.user!, req.params.projectId); }
  @Post("resend-confirmation") resend(@Req() req: Request) { return this.service.resendConfirmation(req.user!, req.params.projectId, req); }
  @Post("unsubscribe") unsubscribe(@Req() req: Request) { return this.service.unsubscribe(req.user!, req.params.projectId, req); }
  @Post("test") test(@Req() req: Request) { return this.service.test(req.user!, req.params.projectId); }
}
