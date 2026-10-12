import { BadRequestException, ConflictException, ForbiddenException, Injectable, Optional } from "@nestjs/common";
import { OrganizationLimitsService } from "./organization-limits.service";
import { DataSource, EntityManager } from "typeorm";
import { ConfigService } from "@nestjs/config";
import { BillingSubscription } from "./billing-subscription.entity";
import { BillingUsageCounter } from "./billing-usage-counter.entity";
import { BillingUsageEvent } from "./billing-usage-event.entity";
import { BillingMetric, BillingPlan, METRIC_LIMIT_KEY, PLAN_ENTITLEMENTS } from "./billing-plan";
import { getBillingConfig } from "./billing.config";
import { ProjectUsageService } from "./project-usage.service";
import { billingScope } from "./billing-scope";
import { BillingInvoice } from "./billing-invoice.entity";
import { ProjectEnvironmentRoute } from "../projects/project-environment-route.entity";

// Stripe remains authoritative for lifecycle state. DeployGuard grants paid
// capacity during active/trialing access and the Smart Retries grace state;
// terminal, incomplete, unpaid and paused subscriptions resolve to FREE.
export const STRIPE_PAID_ENTITLEMENT_STATUSES = new Set(["active", "trialing", "past_due"]);

@Injectable()
export class EntitlementService {
  constructor(private readonly dataSource: DataSource, private readonly projectUsageService: ProjectUsageService, private readonly config: ConfigService = new ConfigService(), @Optional() private readonly organizationLimits?: OrganizationLimitsService) {}

  async planForUser(userId: number, manager?: EntityManager, organizationId?: string | null): Promise<BillingPlan> {
    const repo = (manager || this.dataSource.manager).getRepository(BillingSubscription);
    const subscription = await repo.findOne({ where: billingScope(userId, organizationId) });
    const paidPeriodActive = subscription?.provider !== "b2b" || Boolean(subscription.billingPeriodStart && subscription.billingPeriodStart.getTime() <= Date.now() && subscription.billingPeriodEnd && subscription.billingPeriodEnd.getTime() > Date.now());
    return paidPeriodActive && ["free", "pro", "pro_plus"].includes(subscription?.plan || "") && STRIPE_PAID_ENTITLEMENT_STATUSES.has(subscription?.status || "")
      ? subscription!.plan as BillingPlan : "free";
  }

  async projectUsage(userId: number, manager?: EntityManager, organizationId?: string | null) {
    const plan = await this.planForUser(userId, manager, organizationId);
    const counts = await this.projectUsageService.counts(userId, manager, organizationId);
    const versioned = organizationId && this.organizationLimits ? await this.organizationLimits.effective(organizationId, manager) : null;
    const currentProjectLimit = versioned?.limits.projects ?? PLAN_ENTITLEMENTS[plan].currentProjects;
    return {
      ...counts,
      plan,
      currentProjectLimit,
      liveProjectLimit: PLAN_ENTITLEMENTS[plan].liveProjects,
      projectLimit: currentProjectLimit,
      entitlementVersion: versioned?.version?.version || null,
      hasApprovedProjectLimit: versioned?.limits.projects !== null && versioned?.limits.projects !== undefined,
      overLimit: { currentProjects: counts.currentProjects > currentProjectLimit, liveProjects: counts.liveProjects > PLAN_ENTITLEMENTS[plan].liveProjects },
      enforcement: this.enforcement(),
    };
  }

  async assertCanCreateProject(userId: number, existingManager?: EntityManager, organizationId?: string | null) {
    const check = async (manager: EntityManager) => {
      if (organizationId && this.organizationLimits) {
        await this.organizationLimits.assertCapacity(manager,organizationId,"projects");
        await this.organizationLimits.assertCapacity(manager,organizationId,"environments");
      }
      const billing = getBillingConfig(this.config);
      if (!billing.enabled) return { allowed: true, enforcement: billing };
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`project-create:${organizationId || userId}`]);
      if (billing.enforce) await this.assertNoOverdueInvoice(manager, userId, organizationId);
      const usage = await this.projectUsage(userId, manager, organizationId);
      if (billing.enforce && usage.currentProjects >= usage.currentProjectLimit) {
        throw new ForbiddenException({ code: "DG_CURRENT_PROJECT_QUOTA_REACHED", message: `${usage.plan.toUpperCase()} allows ${usage.currentProjectLimit} current projects; you currently have ${usage.currentProjects}. Upgrade or archive a project before creating another.` });
      }
      return {
        ...usage,
        allowed: true,
        reason: usage.enforcement.reason,
      };
    };
    return existingManager ? check(existingManager) : this.dataSource.transaction(check);
  }

  async assertCanDeployProject(userId: number, projectId: string, existingManager?: EntityManager, organizationId?: string | null) {
    const check = async (manager: EntityManager) => {
      const billing = getBillingConfig(this.config);
      if (!billing.enabled) return { allowed: true, enforcement: billing };
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`billing-live:${organizationId || userId}`]);
      if (billing.enforce) await this.assertNoOverdueInvoice(manager, userId, organizationId);
      const plan = await this.planForUser(userId, manager, organizationId);
      const subscription = await manager.getRepository(BillingSubscription).findOne({ where: billingScope(userId, organizationId) });
      if (billing.enforce && plan === "free" && subscription?.trialEndsAt && subscription.trialEndsAt.getTime() <= Date.now()) {
        throw new ForbiddenException({ code: "DG_FREE_TRIAL_EXPIRED", message: "The 48-hour Free LIVE deployment trial has expired. Upgrade before deploying or continuing this runtime." });
      }
      const usage = await this.projectUsage(userId, manager, organizationId);
      const alreadyLive = await manager.getRepository(ProjectEnvironmentRoute).createQueryBuilder("route")
        .where("route.projectId = :projectId", { projectId }).andWhere("route.liveGenerationId IS NOT NULL").getExists();
      if (billing.enforce && !alreadyLive && usage.liveProjects >= usage.liveProjectLimit) {
        throw new ForbiddenException({ code: "DG_LIVE_PROJECT_QUOTA_REACHED", message: `${plan.toUpperCase()} allows ${usage.liveProjectLimit} simultaneously LIVE project${usage.liveProjectLimit === 1 ? "" : "s"}; you currently have ${usage.liveProjects}. Upgrade or stop an existing LIVE project.` });
      }
      return { ...usage, allowed: true };
    };
    return existingManager ? check(existingManager) : this.dataSource.transaction(check);
  }

  async recordSuccessfulLiveDeployment(userId: number, projectId: string, activatedAt: Date, manager: EntityManager, organizationId?: string | null) {
    await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`billing-subscription:${organizationId || userId}`]);
    if (!getBillingConfig(this.config).enabled || await this.planForUser(userId, manager, organizationId) !== "free") return null;
    const repo = manager.getRepository(BillingSubscription);
    let subscription = await repo.findOne({ where: billingScope(userId, organizationId) });
    subscription ||= repo.create({ userId, organizationId: organizationId || null, plan: "free", status: "active", provider: "none", mode: "not_configured" });
    if (!subscription.trialStartedAt) {
      subscription.trialStartedAt = activatedAt;
      subscription.trialEndsAt = new Date(activatedAt.getTime() + 48 * 60 * 60 * 1000);
      subscription.trialProjectId = projectId;
      subscription.mode = "not_configured";
      await repo.save(subscription);
    }
    return subscription;
  }

  async reconcileFreeTrial(userId: number, organizationId?: string | null) {
    const billing = getBillingConfig(this.config);
    if (!billing.enabled) return null;
    return this.dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`billing-subscription:${organizationId || userId}`]);
      if (await this.planForUser(userId, manager, organizationId) !== "free") return null;
      const repo = manager.getRepository(BillingSubscription);
      let subscription = await repo.findOne({ where: billingScope(userId, organizationId) });
      subscription ||= repo.create({ userId, organizationId: organizationId || null, plan: "free", status: "active", provider: "none", mode: "not_configured" });
      if (subscription.trialStartedAt) return subscription;
      const live = await this.projectUsageService.earliestLiveProject(userId, manager, organizationId);
      if (!live) return subscription.id ? subscription : repo.save(subscription);
      const startedAt = new Date(live.activatedAt);
      subscription.trialStartedAt = startedAt;
      subscription.trialEndsAt = new Date(startedAt.getTime() + 48 * 60 * 60 * 1000);
      subscription.trialProjectId = live.projectId;
      return repo.save(subscription);
    });
  }

  async consume(userId: number, metric: BillingMetric, idempotencyKey: string, quantity = 1, metadata: Record<string, unknown> = {}, organizationId?: string | null) {
    if (!Number.isSafeInteger(quantity) || quantity < 1 || !idempotencyKey.trim() || !Object.prototype.hasOwnProperty.call(METRIC_LIMIT_KEY, metric)) throw new BadRequestException("Valid metric, positive integer quantity and metering identity are required.");
    return this.dataSource.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`usage:${organizationId || userId}:${metric}`]);
      const eventRepo = manager.getRepository(BillingUsageEvent);
      const existing = await eventRepo.findOne({ where: { idempotencyKey } });
      if (existing) {
        if ((existing.organizationId || null) !== (organizationId || null) || (!organizationId && existing.userId !== userId) || existing.metric !== metric || existing.quantity !== quantity) throw new ConflictException("Metering identity belongs to a different billing scope or quantity.");
        return { consumed: false, quantity: existing.quantity, idempotent: true };
      }
      const plan = await this.planForUser(userId, manager, organizationId);
      const periodStart = this.periodStart();
      const periodEnd = this.periodEnd();
      const counterRepo = manager.getRepository(BillingUsageCounter);
      let counter = await counterRepo.findOne({ where: { ...billingScope(userId, organizationId), metric, periodStart } });
      if (!counter) counter = counterRepo.create({ userId, organizationId: organizationId || null, metric, periodStart, periodEnd, quantity: 0 });
      const limit = Number(PLAN_ENTITLEMENTS[plan][METRIC_LIMIT_KEY[metric]]);
      const billing = getBillingConfig(this.config);
      const enforcement = this.enforcement();
      if (enforcement.enabled && counter.quantity + quantity > limit) throw new ForbiddenException(`${plan === "free" ? "Free" : "Pro"} plan ${metric.replaceAll("_", " ")} limit reached (${limit} per month).`);
      counter.quantity += quantity;
      await counterRepo.save(counter);
      await eventRepo.save(eventRepo.create({ userId, organizationId: organizationId || null, metric, idempotencyKey, quantity, periodStart, metadata: this.safeMetadata(metadata) }));
      return { consumed: true, quantity: counter.quantity, limit, plan, idempotent: false, enforcement };
    });
  }

  async usage(userId: number, organizationId?: string | null) {
    const plan = await this.planForUser(userId, undefined, organizationId);
    const rows = await this.dataSource.getRepository(BillingUsageCounter).find({ where: { ...billingScope(userId, organizationId), periodStart: this.periodStart() } });
    const usage = Object.fromEntries(rows.map((row) => [row.metric, row.quantity]));
    const billing = getBillingConfig(this.config);
    return { plan, entitlements: PLAN_ENTITLEMENTS[plan], usage, periodStart: this.periodStart(), periodEnd: this.periodEnd(), enforcement: this.enforcement(), billing };
  }

  periodStart(date = new Date()) { return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`; }
  private async assertNoOverdueInvoice(manager: EntityManager, userId: number, organizationId?: string | null) {
    const overdue = await manager.getRepository(BillingInvoice).createQueryBuilder("invoice")
      .where(organizationId ? "invoice.organizationId = :organizationId" : "invoice.organizationId IS NULL AND invoice.userId = :userId", organizationId ? { organizationId } : { userId })
      .andWhere("invoice.provider = 'b2b' AND invoice.status = 'open' AND invoice.dueAt < :now", { now: new Date() }).getExists();
    if (overdue) throw new ForbiddenException({ code: "DG_BILLING_OVERDUE", message: "An organization invoice is overdue. Reconcile payment before creating a new project or deployment." });
  }
  periodEnd(date = new Date()) { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10); }
  private safeMetadata(metadata: Record<string, unknown>) { return Object.fromEntries(Object.entries(metadata).filter(([key]) => ["projectId", "pipelineRunId", "sessionId", "exportId", "deliveryId"].includes(key))); }
  private enforcement() {
    const billing = getBillingConfig(this.config);
    return { enabled: billing.enforce, reason: !billing.enabled ? "billing_disabled" : billing.enforce ? "billing_enforced" : "fyp_observation_only" };
  }
}
