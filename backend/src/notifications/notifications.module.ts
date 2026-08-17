import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { LogSanitizerService } from "../observability/log-sanitizer.service";
import { Project } from "../projects/project.entity";
import { NotificationDelivery } from "./notification-delivery.entity";
import { NotificationDispatcherService } from "./notification-dispatcher.service";
import { NotificationPreference } from "./notification-preference.entity";
import { NotificationSubscription } from "./notification-subscription.entity";
import { NotificationsService } from "./notifications.service";
import { SnsNotificationAdapter } from "./sns-notification.adapter";
import { NotificationsController } from "./notifications.controller";

@Module({ imports: [TypeOrmModule.forFeature([Project, NotificationPreference, NotificationSubscription, NotificationDelivery]), AuditLogModule], controllers: [NotificationsController], providers: [LogSanitizerService, SnsNotificationAdapter, NotificationDispatcherService, NotificationsService], exports: [SnsNotificationAdapter, NotificationDispatcherService, NotificationsService] })
export class NotificationsModule {}
