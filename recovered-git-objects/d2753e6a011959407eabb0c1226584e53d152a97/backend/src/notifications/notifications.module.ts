import { forwardRef, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { BillingModule } from "../billing/billing.module";
import { ObservabilityModule } from "../observability/observability.module";
import { Project } from "../projects/project.entity";
import { NotificationDelivery } from "./notification-delivery.entity";
import { NotificationDispatcherService } from "./notification-dispatcher.service";
import { NotificationPreference } from "./notification-preference.entity";
import { NotificationSubscription } from "./notification-subscription.entity";
import { NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";
import { SnsNotificationAdapter } from "./sns-notification.adapter";

@Module({ imports: [TypeOrmModule.forFeature([Project, NotificationPreference, NotificationSubscription, NotificationDelivery]), AuditLogModule, forwardRef(() => BillingModule), ObservabilityModule], controllers: [NotificationsController], providers: [SnsNotificationAdapter, NotificationDispatcherService, NotificationsService], exports: [NotificationDispatcherService, NotificationsService] })
export class NotificationsModule {}
