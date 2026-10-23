import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { EntitlementService } from "../billing/entitlement.service";
import { PLAN_ENTITLEMENTS } from "../billing/billing-plan";
import { LogSanitizerService } from "../observability/log-sanitizer.service";
import { Project } from "../projects/project.entity";
import { NotificationDelivery } from "./notification-delivery.entity";
import { NotificationPreference } from "./notification-preference.entity";
import { NotificationSubscription } from "./notification-subscription.entity";
import { SnsNotificationAdapter } from "./sns-notification.adapter";

export type LifecycleNotificationInput = { projectId: string; pipelineRunId?: string | null; eventId?: string | null; stage: string; status: string; message: string };

@Injectable()
export class NotificationDispatcherService {
  constructor(
    @InjectRepository(Project) private readonly projectRepo: Repository<Project>,
    @InjectRepository(NotificationPreference) private readonly preferenceRepo: Repository<NotificationPreference>,
    @InjectRepository(NotificationSubscription) private readonly subscriptionRepo: Repository<NotificationSubscription>,
    @InjectRepository(NotificationDelivery) private readonly deliveryRepo: Repository<NotificationDelivery>,
    private readonly sns: SnsNotificationAdapter,
    private readonly entitlements: EntitlementService,
    private readonly sanitizer: LogSanitizerService,
    private readonly audit: AuditLogService
  ) {}

  classify(stage: string, status: string) {
    const value = `${stage}:${status}`.toLowerCase();
    if (/destroy.*(completed|success)/.test(value)) return { type: "destroy_completed", kind: "critical" };
    if (/destroy.*fail/.test(value)) return { type: "destroy_failed", kind: "critical" };
    if (/destroy.*(start|running)/.test(value)) return { type: "destroy_started", kind: "stage" };
    if (/rollback.*fail/.test(value)) return { type: "rollback_failed", kind: "critical" };
    if (/rollback.*(completed|succeed)/.test(value)) return { type: "rollback_completed", kind: "success" };
    if (/rollback.*(start|running)/.test(value)) return { type: "rollback_started", kind: "stage" };
    if (/security.*(block|fail)|dockerfile_(?:security_)?check_(?:failed|blocked)/.test(value)) return { type: "security_policy_block", kind: "critical" };
    if (/cancel/.test(value)) return { type: "deployment_cancelled", kind: "stage" };
    if (/fail|blocked/.test(value)) return { type: "deployment_failed", kind: "critical" };
    if (/completed|deployed|stable_release/.test(value)) return { type: "deployment_succeeded", kind: "success" };
    if (/scan|trivy|security/.test(value)) return { type: "scanning", kind: "stage" };
    if (/terraform|provision|state_lock/.test(value)) return { type: "provisioning", kind: "stage" };
    if (/build|docker/.test(value)) return { type: "building", kind: "stage" };
    if (/queue/.test(value)) return { type: "queued", kind: "stage" };
    return null;
  }

  async dispatch(input: LifecycleNotificationInput) {
    const classification = this.classify(input.stage, input.status);
    if (!classification) return null;
    const project = await this.projectRepo.findOne({ where: { id: input.projectId } });
    if (!project) return null;
    const pref = await this.getOrCreatePreference(project.ownerUserId, project.id);
    const enabled = classification.kind === "critical" ? pref.criticalEnabled : classification.kind === "success" ? pref.successEnabled : pref.stageUpdatesEnabled;
    if (!enabled) return null;
    const plan = await this.entitlements.planForUser(project.ownerUserId);
    if (classification.kind === "stage" && !PLAN_ENTITLEMENTS[plan].notificationStageUpdates) return null;
    const key = `${input.projectId}:${input.pipelineRunId || "none"}:${input.eventId || input.stage}:${classification.type}`;
    const existing = await this.deliveryRepo.findOne({ where: { deduplicationKey: key } });
    if (existing) return existing;
    const message = this.sanitizer.sanitize(input.message).slice(0, 2000);
    const delivery = await this.deliveryRepo.save(this.deliveryRepo.create({ userId: project.ownerUserId, projectId: project.id, pipelineRunId: input.pipelineRunId || null, eventType: classification.type, deduplicationKey: key, status: "pending", subject: `DeployGuard: ${project.name} ${classification.type.replaceAll("_", " ")}`, message, safeMetadata: { stage: input.stage, status: input.status } }));
    if (!this.sns.status().configured) { delivery.status = "skipped_unconfigured"; return this.deliveryRepo.save(delivery); }
    const confirmed = await this.subscriptionRepo.findOne({ where: { userId: project.ownerUserId, projectId: project.id, status: "confirmed" } });
    if (!confirmed) { delivery.status = "skipped_unconfirmed"; return this.deliveryRepo.save(delivery); }
    await this.entitlements.consume(project.ownerUserId, "notification", `notification:${delivery.id}`, 1, { projectId: project.id, deliveryId: delivery.id });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        delivery.attempts = attempt;
        const result = await this.sns.send(project.ownerUserId, delivery.subject, delivery.message);
        delivery.status = result.status; delivery.providerMessageId = result.messageId; delivery.sentAt = result.status === "sent" ? new Date() : null; delivery.lastError = null;
        await this.deliveryRepo.save(delivery);
        await this.audit.record({ action: "NOTIFICATION_DISPATCHED", resourceType: "notification", resourceId: delivery.id, status: "success", metadata: { projectId: project.id, eventType: classification.type, attempts: attempt } });
        return delivery;
      } catch (error) {
        delivery.attempts = attempt; delivery.lastError = this.sanitizer.sanitize((error as Error).name || "Notification provider error").slice(0, 300); delivery.status = attempt === 3 ? "failed_permanent" : "retrying"; await this.deliveryRepo.save(delivery);
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** (attempt - 1)));
      }
    }
    await this.audit.record({ action: "NOTIFICATION_FAILED_PERMANENT", resourceType: "notification", resourceId: delivery.id, status: "failed", metadata: { projectId: project.id, eventType: classification.type, attempts: delivery.attempts } });
    return delivery;
  }

  async getOrCreatePreference(userId: number, projectId: string) { return (await this.preferenceRepo.findOne({ where: { userId, projectId } })) || this.preferenceRepo.save(this.preferenceRepo.create({ userId, projectId })); }

  async dispatchAccount(userId: number, eventId: string, eventType: "billing_payment_failed", message: string) {
    const key = `account:${userId}:${eventId}:${eventType}`;
    const existing = await this.deliveryRepo.findOne({ where: { deduplicationKey: key } });
    if (existing) return existing;
    const delivery = await this.deliveryRepo.save(this.deliveryRepo.create({ userId, projectId: null, pipelineRunId: null, eventType, deduplicationKey: key, status: "pending", providerMessageId: null, attempts: 0, lastError: null, subject: "DeployGuard: billing payment failed", message: this.sanitizer.sanitize(message).slice(0, 1000), safeMetadata: { eventType }, sentAt: null }));
    if (!this.sns.status().configured) { delivery.status = "skipped_unconfigured"; return this.deliveryRepo.save(delivery); }
    const confirmed = await this.subscriptionRepo.findOne({ where: { userId, status: "confirmed" } });
    if (!confirmed) { delivery.status = "skipped_unconfirmed"; return this.deliveryRepo.save(delivery); }
    for (let attempt = 1; attempt <= 3; attempt += 1) { try { const result = await this.sns.send(userId, delivery.subject, delivery.message); delivery.attempts = attempt; delivery.status = result.status; delivery.providerMessageId = result.messageId; delivery.sentAt = result.status === "sent" ? new Date() : null; return this.deliveryRepo.save(delivery); } catch { delivery.attempts = attempt; delivery.status = attempt === 3 ? "failed_permanent" : "retrying"; await this.deliveryRepo.save(delivery); } }
    return delivery;
  }
}
