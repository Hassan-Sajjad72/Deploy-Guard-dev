import { ForbiddenException, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Request } from "express";
import { Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { LogSanitizerService } from "../observability/log-sanitizer.service";
import { Project } from "../projects/project.entity";
import { User, UserRole } from "../users/user.entity";
import { UpdateNotificationPreferencesDto } from "./dto/update-notification-preferences.dto";
import { NotificationDelivery } from "./notification-delivery.entity";
import { NotificationDispatcherService } from "./notification-dispatcher.service";
import { NotificationPreference } from "./notification-preference.entity";
import { NotificationSubscription } from "./notification-subscription.entity";
import { SnsNotificationAdapter } from "./sns-notification.adapter";

@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(Project) private readonly projectRepo: Repository<Project>,
    @InjectRepository(NotificationPreference) private readonly prefRepo: Repository<NotificationPreference>,
    @InjectRepository(NotificationSubscription) private readonly subRepo: Repository<NotificationSubscription>,
    @InjectRepository(NotificationDelivery) private readonly deliveryRepo: Repository<NotificationDelivery>,
    private readonly dispatcher: NotificationDispatcherService,
    private readonly sns: SnsNotificationAdapter,
    private readonly audit: AuditLogService,
    private readonly sanitizer: LogSanitizerService,
  ) {}

  async settings(user: User, projectId: string) {
    const project = await this.manage(user, projectId);
    const preference = await this.dispatcher.getOrCreatePreference(user.id, project.id);
    const subscription = await this.latestSubscription(user.id, projectId);
    const deliveries = await this.deliveryRepo.find({ where: { userId: user.id, projectId }, order: { createdAt: "DESC" }, take: 20 });
    return {
      preference,
      subscription: subscription ? this.safeSubscription(subscription) : null,
      configurationStatus: !preference.enabled ? "disabled" : this.presentationStatus(subscription),
      provider: this.sns.status(),
      deliveries: deliveries.map((item) => ({
        id: item.id,
        eventType: item.eventType,
        status: item.status,
        subject: item.subject,
        attempts: item.attempts,
        lastError: item.lastError,
        metadata: item.safeMetadata || {},
        createdAt: item.createdAt,
        sentAt: item.sentAt,
      })),
    };
  }

  async update(user: User, projectId: string, dto: UpdateNotificationPreferencesDto, req?: Request) {
    await this.manage(user, projectId);
    const preference = await this.dispatcher.getOrCreatePreference(user.id, projectId);
    Object.assign(preference, dto);
    await this.prefRepo.save(preference);
    await this.audit.record({ actorUser: user, action: "NOTIFICATION_PREFERENCES_UPDATED", resourceType: "notification", resourceId: preference.id, status: "success", metadata: { projectId, enabled: preference.enabled, criticalEnabled: preference.criticalEnabled, successEnabled: preference.successEnabled, stageUpdatesEnabled: preference.stageUpdatesEnabled }, req });
    return this.settings(user, projectId);
  }

  async subscribe(user: User, projectId: string, requestedEmail: string, req?: Request) {
    await this.manage(user, projectId);
    const email = requestedEmail.trim().toLowerCase();
    const current = await this.latestSubscription(user.id, projectId);
    if (current && current.destination !== email) {
      await this.sns.unsubscribe(current.providerSubscriptionArn);
      current.status = "replaced";
      await this.subRepo.save(current);
    }
    let subscription = await this.subRepo.findOne({ where: { userId: user.id, projectId, destination: email } });
    subscription ||= this.subRepo.create({ userId: user.id, projectId, destination: email, protocol: "email", status: "not_configured", providerSubscriptionArn: null, providerTopicArn: current?.providerTopicArn || null, confirmedAt: null, lastError: null });
    try {
      const existing = await this.sns.findSubscription(email, user.id, projectId, subscription.providerTopicArn, subscription.providerSubscriptionArn);
      const result = existing || await this.sns.subscribe(email, user.id, projectId);
      subscription.status = result.status;
      subscription.providerSubscriptionArn = result.subscriptionArn;
      subscription.providerTopicArn = result.topicArn;
      subscription.confirmedAt = result.status === "confirmed" ? new Date() : null;
      subscription.lastError = null;
    } catch (error) {
      subscription.status = "error";
      subscription.lastError = this.safeProviderError(error);
    }
    subscription = await this.subRepo.save(subscription);
    const preference = await this.dispatcher.getOrCreatePreference(user.id, projectId);
    preference.enabled = true;
    await this.prefRepo.save(preference);
    await this.audit.record({ actorUser: user, action: "NOTIFICATION_SUBSCRIBED", resourceType: "notification", resourceId: subscription.id, status: subscription.status === "error" ? "failed" : "success", metadata: { projectId, subscriptionStatus: subscription.status }, req });
    return this.safeSubscription(subscription);
  }

  async resendConfirmation(user: User, projectId: string, req?: Request) {
    await this.manage(user, projectId);
    const subscription = await this.latestSubscription(user.id, projectId);
    if (!subscription) return null;
    try {
      const result = await this.sns.recreateSubscription(subscription.destination, user.id, projectId, subscription.providerTopicArn);
      subscription.status = result.status;
      subscription.providerSubscriptionArn = result.subscriptionArn;
      subscription.providerTopicArn = result.topicArn;
      subscription.confirmedAt = result.status === "confirmed" ? new Date() : null;
      subscription.lastError = null;
    } catch (error) {
      subscription.status = "error";
      subscription.lastError = this.safeProviderError(error);
    }
    await this.subRepo.save(subscription);
    await this.audit.record({ actorUser: user, action: "NOTIFICATION_CONFIRMATION_RECREATED", resourceType: "notification", resourceId: subscription.id, status: subscription.status === "error" ? "failed" : "success", metadata: { projectId, subscriptionStatus: subscription.status }, req });
    return this.safeSubscription(subscription);
  }

  async refreshStatus(user: User, projectId: string) {
    await this.manage(user, projectId);
    const subscription = await this.latestSubscription(user.id, projectId);
    if (!subscription) return null;
    try {
      const current = await this.sns.findSubscription(subscription.destination, user.id, projectId, subscription.providerTopicArn, subscription.providerSubscriptionArn);
      if (current) {
        subscription.status = current.status;
        subscription.providerSubscriptionArn = current.subscriptionArn;
        subscription.providerTopicArn = current.topicArn;
        subscription.confirmedAt = current.status === "confirmed" ? new Date() : null;
        subscription.lastError = null;
        await this.subRepo.save(subscription);
      }
    } catch (error) {
      subscription.status = "error";
      subscription.lastError = this.safeProviderError(error);
      await this.subRepo.save(subscription);
    }
    return this.safeSubscription(subscription);
  }

  async unsubscribe(user: User, projectId: string, req?: Request) {
    await this.manage(user, projectId);
    const subscription = await this.latestSubscription(user.id, projectId);
    if (subscription) {
      await this.sns.unsubscribe(subscription.providerSubscriptionArn);
      subscription.status = "unsubscribed";
      await this.subRepo.save(subscription);
    }
    const preference = await this.dispatcher.getOrCreatePreference(user.id, projectId);
    preference.enabled = false;
    await this.prefRepo.save(preference);
    await this.audit.record({ actorUser: user, action: "NOTIFICATION_UNSUBSCRIBED", resourceType: "notification", resourceId: subscription?.id || preference.id, status: "success", metadata: { projectId }, req });
    return { status: "unsubscribed" };
  }

  async test(user: User, projectId: string) {
    await this.manage(user, projectId);
    return this.dispatcher.dispatch({ projectId, eventId: `test-${Date.now()}`, stage: "deployment_failed", status: "failed", message: "This is a DeployGuard test notification." });
  }

  private async latestSubscription(userId: number, projectId: string) {
    return this.subRepo.findOne({ where: { userId, projectId }, order: { updatedAt: "DESC" } });
  }
  private presentationStatus(subscription: NotificationSubscription | null) {
    if (!subscription || ["unsubscribed", "replaced", "not_configured", "skipped_unconfigured"].includes(subscription.status)) return "not_configured";
    if (subscription.status === "pending_confirmation") return "pending_confirmation";
    if (subscription.status === "confirmed") return "confirmed";
    return "error";
  }
  private safeSubscription(subscription: NotificationSubscription) {
    return { id: subscription.id, destination: subscription.destination, protocol: subscription.protocol, status: this.presentationStatus(subscription), confirmedAt: subscription.confirmedAt, lastError: subscription.lastError, createdAt: subscription.createdAt, updatedAt: subscription.updatedAt };
  }
  private safeProviderError(error: unknown) {
    const name = error instanceof Error ? error.name : "NotificationProviderError";
    return this.sanitizer.sanitize(`Amazon SNS request failed (${name}).`).slice(0, 300);
  }
  private async manage(user: User, projectId: string) {
    const project = await this.projectRepo.findOne({ where: { id: projectId } });
    if (!project || user.role === UserRole.READONLY || (user.role !== UserRole.ADMIN && project.ownerUserId !== user.id)) throw new ForbiddenException("Insufficient permissions");
    return project;
  }
}
