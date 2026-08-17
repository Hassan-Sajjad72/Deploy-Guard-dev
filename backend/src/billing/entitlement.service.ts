import { ForbiddenException, Injectable } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { BillingSubscription } from "./billing-subscription.entity";
import { BillingUsageCounter } from "./billing-usage-counter.entity";
import { BillingUsageEvent } from "./billing-usage-event.entity";
import { BillingMetric, BillingPlan, METRIC_LIMIT_KEY, PLAN_ENTITLEMENTS } from "./billing-plan";
import { ProjectUsageService } from "./project-usage.service";
import { getPlanUsageEnforcementConfig } from "./plan-usage-enforcement.config";

@Injectable()
export class EntitlementService {
  constructor(private readonly dataSource: DataSource, private readonly projectUsageService: ProjectUsageService) {}

  async planForUser(userId: number, manager?: EntityManager): Promise<BillingPlan> {
    const repo = (manager || this.dataSource.manager).getRepository(BillingSubscription);
    const subscription = await repo.findOne({ where: { userId } });
    return subscription?.plan === "pro" && subscription.provider === "stripe" && subscription.mode === "live" && ["trialing", "active", "past_due"].includes(subscription.status) ? "pro" : "free";
  }

  async projectUsage(userId: number, manager?: EntityManager) {
    const plan = await this.planForUser(userId, manager);
    const counts = await this.projectUsageService.counts(userId, manager);
    return {
      ...counts,
      plan,
      projectLimit: PLAN_ENTITLEMENTS[plan].activeProjects,
      enforcement: getPlanUsageEnforcementConfig(),
    };
  }

  async assertCanCreateProject(userId: number, existingManager?: EntityManager) {
    const check = async (manager: EntityManager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`project-create:${userId}`]);
      const usage = await this.projectUsage(userId, manager);
      if (usage.enforcement.enabled && usage.activeProjects >= usage.projectLimit) {
        throw new ForbiddenException(`${usage.plan === "free" ? "Free" : "Pro"} plan allows ${usage.projectLimit} active projects; you currently have ${usage.activeProjects}. Open Projects and archive one before creating another.`);
      }
      return {
        ...usage,
        allowed: true,
        reason: usage.enforcement.reason,
      };
    };
    return existingManager ? check(existingManager) : this.dataSource.transaction(check);
  }

  async consume(userId: number, metric: BillingMetric, idempotencyKey: string, quantity = 1, metadata: Record<string, unknown> = {}) {
    return this.dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`usage:${userId}:${metric}`]);
      const eventRepo = manager.getRepository(BillingUsageEvent);
      const existing = await eventRepo.findOne({ where: { idempotencyKey } });
      if (existing) return { consumed: false, quantity: existing.quantity, idempotent: true };
      const plan = await this.planForUser(userId, manager);
      const periodStart = this.periodStart();
      const periodEnd = this.periodEnd();
      const counterRepo = manager.getRepository(BillingUsageCounter);
      let counter = await counterRepo.findOne({ where: { userId, metric, periodStart } });
      if (!counter) counter = counterRepo.create({ userId, metric, periodStart, periodEnd, quantity: 0 });
      const limit = Number(PLAN_ENTITLEMENTS[plan][METRIC_LIMIT_KEY[metric]]);
      const enforcement = getPlanUsageEnforcementConfig();
      if (enforcement.enabled && counter.quantity + quantity > limit) throw new ForbiddenException(`${plan === "free" ? "Free" : "Pro"} plan ${metric.replaceAll("_", " ")} limit reached (${limit} per month).`);
      counter.quantity += quantity;
      await counterRepo.save(counter);
      await eventRepo.save(eventRepo.create({ userId, metric, idempotencyKey, quantity, periodStart, metadata: this.safeMetadata(metadata) }));
      return { consumed: true, quantity: counter.quantity, limit, plan, idempotent: false, enforcement };
    });
  }

  async usage(userId: number) {
    const plan = await this.planForUser(userId);
    const rows = await this.dataSource.getRepository(BillingUsageCounter).find({ where: { userId, periodStart: this.periodStart() } });
    const usage = Object.fromEntries(rows.map((row) => [row.metric, row.quantity]));
    return { plan, entitlements: PLAN_ENTITLEMENTS[plan], usage, periodStart: this.periodStart(), periodEnd: this.periodEnd(), enforcement: getPlanUsageEnforcementConfig() };
  }

  periodStart(date = new Date()) { return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`; }
  periodEnd(date = new Date()) { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10); }
  private safeMetadata(metadata: Record<string, unknown>) { return Object.fromEntries(Object.entries(metadata).filter(([key]) => ["projectId", "pipelineRunId", "sessionId", "exportId", "deliveryId"].includes(key))); }
}
