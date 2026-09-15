import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { InjectRepository } from "@nestjs/typeorm";
import { Request } from "express";
import Stripe = require("stripe");
import { DataSource, EntityManager, IsNull, Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { User } from "../users/user.entity";
import { BillingAccount } from "./billing-account.entity";
import { BillingCheckoutSession } from "./billing-checkout-session.entity";
import { BillingInvoice } from "./billing-invoice.entity";
import { BillingPayment } from "./billing-payment.entity";
import { BillingProviderService } from "./billing-provider.service";
import { BillingSubscription } from "./billing-subscription.entity";
import { BillingWebhookEvent } from "./billing-webhook-event.entity";
import { EntitlementService } from "./entitlement.service";
import { ProjectUsageService } from "./project-usage.service";
import { BILLING_PLAN_ORDER, BillingPlan, MINIMUM_LIVE_PROJECT_COST_USD, PLAN_ENTITLEMENTS, publicBillingPlan } from "./billing-plan";
import { getBillingConfig } from "./billing.config";
import { renderInvoicePdf } from "./invoice-pdf";

const SUBSCRIPTION_EVENTS = new Set(["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"]);
const INVOICE_EVENTS = new Set(["invoice.paid", "invoice.payment_failed"]);
const TERMINAL_SUBSCRIPTION_STATUSES = new Set(["canceled", "incomplete_expired", "unpaid"]);

@Injectable()
export class BillingService {
  constructor(
    @InjectRepository(BillingAccount) private readonly accountRepo: Repository<BillingAccount>,
    @InjectRepository(BillingSubscription) private readonly subscriptionRepo: Repository<BillingSubscription>,
    @InjectRepository(BillingCheckoutSession) private readonly checkoutRepo: Repository<BillingCheckoutSession>,
    @InjectRepository(BillingInvoice) private readonly invoiceRepo: Repository<BillingInvoice>,
    @InjectRepository(BillingPayment) private readonly paymentRepo: Repository<BillingPayment>,
    @InjectRepository(BillingWebhookEvent) private readonly webhookRepo: Repository<BillingWebhookEvent>,
    private readonly dataSource: DataSource,
    private readonly provider: BillingProviderService,
    private readonly entitlements: EntitlementService,
    private readonly projectUsage: ProjectUsageService,
    private readonly auditLog: AuditLogService,
    private readonly config: ConfigService,
  ) {}

  async summary(user: User) {
    await this.entitlements.reconcileFreeTrial(user.id);
    const [subscription, account, invoices, payments] = await Promise.all([
      this.ensureSubscription(user.id),
      this.accountRepo.findOne({ where: { userId: user.id } }),
      this.invoiceRepo.find({ where: { userId: user.id, invalidatedAt: IsNull() }, order: { createdAt: "DESC" }, take: 25 }),
      this.paymentRepo.find({ where: { userId: user.id }, order: { createdAt: "DESC" }, take: 25 }),
    ]);
    const provider = this.provider.status();
    const usage = await this.entitlements.usage(user.id);
    const projectUsage = await this.entitlements.projectUsage(user.id);
    const deploymentRuns = await this.projectUsage.deploymentRunsSince(user.id, new Date(usage.periodStart));
    const limitsVisible = usage.billing.enabled;
    return {
      provider, enforcement: usage.enforcement, plan: usage.plan, planName: publicBillingPlan(usage.plan),
      pricing: { monthlyUsd: PLAN_ENTITLEMENTS[usage.plan].priceUsdMonthly, minimumLiveProjectCostUsd: MINIMUM_LIVE_PROJECT_COST_USD },
      billing: usage.billing, status: subscription.status, cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      billingPeriodStart: subscription.billingPeriodStart, billingPeriodEnd: subscription.billingPeriodEnd,
      providerSubscriptionId: subscription.providerSubscriptionId,
      customerPortalAvailable: Boolean(provider.configured && account?.providerCustomerId),
      trial: this.trialView(subscription), entitlements: usage.entitlements, usage: usage.usage,
      usagePeriod: { start: usage.periodStart, end: usage.periodEnd },
      workspaceUsage: { ...projectUsage, deploymentRuns, limits: { currentProjects: limitsVisible ? projectUsage.currentProjectLimit : null, liveProjects: limitsVisible ? projectUsage.liveProjectLimit : null, deploymentRuns: null } },
      paymentMethod: null,
      payments: payments.map((payment) => ({ id: payment.id, status: payment.status, amount: payment.amount, currency: payment.currency, plan: payment.plan, provider: payment.provider, providerTransactionId: payment.providerTransactionId, paidAt: payment.paidAt })),
      invoices: invoices.map((invoice) => this.invoiceView(invoice)),
    };
  }

  async createCheckout(user: User, plan: Exclude<BillingPlan, "free">, req?: Request) {
    const billing = getBillingConfig(this.config);
    if (!billing.enabled) throw new BadRequestException("Billing is disabled.");
    const current = await this.entitlements.planForUser(user.id);
    if (BILLING_PLAN_ORDER.indexOf(plan) <= BILLING_PLAN_ORDER.indexOf(current)) throw new BadRequestException("Stripe Checkout may only upgrade the current plan.");
    const existingSubscription = await this.subscriptionRepo.findOne({ where: { userId: user.id } });
    if (existingSubscription?.providerSubscriptionId && !TERMINAL_SUBSCRIPTION_STATUSES.has(existingSubscription.status)) {
      throw new BadRequestException("An existing Stripe subscription must be changed through Manage Billing.");
    }
    const customerId = await this.ensureCustomer(user);
    const orderId = `dg-${randomUUID()}`;
    const priceId = this.provider.priceIdForPlan(plan);
    let row = await this.checkoutRepo.save(this.checkoutRepo.create({
      userId: user.id, providerSessionId: `pending:${orderId}`, merchantOrderId: orderId,
      provider: "stripe", mode: "test", plan, status: "creating",
      amountDue: PLAN_ENTITLEMENTS[plan].priceUsdMonthly * 100, currency: "USD",
      providerCustomerId: customerId, providerSubscriptionId: null, providerPriceId: priceId, expiresAt: null,
    }));
    try {
      const checkout = await this.provider.createCheckout(orderId, plan, user, customerId);
      row.providerSessionId = checkout.id;
      row.providerCustomerId = checkout.customerId;
      row.providerPriceId = checkout.priceId;
      row.status = "created";
      row.expiresAt = checkout.expiresAt;
      row = await this.checkoutRepo.save(row);
      await this.auditLog.record({ actorUser: user, action: "BILLING_CHECKOUT_CREATED", resourceType: "billing", resourceId: row.id, status: "success", metadata: { provider: "stripe", mode: "test", plan, priceId }, req });
      return { checkoutUrl: checkout.url, checkoutSessionId: row.id, providerSessionId: checkout.id, orderId, provider: "stripe", mode: "test", status: "awaiting_verified_webhook", message: "Stripe Test Mode subscription Checkout created." };
    } catch (error) {
      row.status = "failed";
      await this.checkoutRepo.save(row);
      throw error;
    }
  }

  async createPortal(user: User) {
    const account = await this.accountRepo.findOne({ where: { userId: user.id } });
    if (!account?.providerCustomerId) throw new BadRequestException("No Stripe customer exists for this account yet.");
    const portal = await this.provider.createPortal(account.providerCustomerId);
    return { portalUrl: portal.url, provider: "stripe", mode: "test" };
  }

  async handleStripeWebhook(rawBody: Buffer, signature: string) {
    const event = this.provider.verifyWebhook(rawBody, signature);
    return this.dataSource.transaction("READ COMMITTED", async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`stripe-event:${event.eventId}`]);
      const webhookRepo = manager.getRepository(BillingWebhookEvent);
      let webhook = await webhookRepo.findOne({ where: { providerEventId: event.eventId } });
      if (webhook?.status === "processed") return { received: true, duplicate: true, status: "processed" };
      webhook ||= webhookRepo.create({ providerEventId: event.eventId, provider: "stripe", eventType: event.eventType, status: "received", occurredAt: event.occurredAt, processedAt: null, safeMetadata: null });

      let result: Record<string, unknown> = { received: true, duplicate: false, status: "ignored" };
      if (event.eventType === "checkout.session.completed") {
        result = await this.processCheckoutCompleted(manager, event.object as Stripe.Checkout.Session, event.occurredAt);
      } else if (SUBSCRIPTION_EVENTS.has(event.eventType)) {
        result = await this.processSubscriptionEvent(manager, event.eventType, event.object as Stripe.Subscription, event.occurredAt);
      } else if (INVOICE_EVENTS.has(event.eventType)) {
        result = await this.processInvoiceEvent(manager, event.eventType, event.object as Stripe.Invoice, event.occurredAt);
      }

      webhook.status = "processed";
      webhook.processedAt = new Date();
      webhook.safeMetadata = this.webhookMetadata(event.object);
      await webhookRepo.save(webhook);
      return result;
    });
  }

  async invoice(user: User, invoiceId: string) {
    const invoice = await this.invoiceRepo.findOne({ where: { id: invoiceId, userId: user.id, invalidatedAt: IsNull() } });
    if (!invoice) throw new NotFoundException("Invoice not found.");
    return { ...this.invoiceView(invoice), account: { id: user.id, name: user.name, email: user.email } };
  }

  async invoicePdf(user: User, invoiceId: string) {
    const invoice = await this.invoiceRepo.findOne({ where: { id: invoiceId, userId: user.id, invalidatedAt: IsNull() } });
    if (!invoice) throw new NotFoundException("Invoice not found.");
    return { filename: `${invoice.invoiceNumber}.pdf`, content: renderInvoicePdf(invoice, user) };
  }

  private async ensureCustomer(user: User) {
    return this.dataSource.transaction("READ COMMITTED", async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`stripe-customer:${user.id}`]);
      const repo = manager.getRepository(BillingAccount);
      let account = await repo.findOne({ where: { userId: user.id } });
      if (account?.providerCustomerId) return account.providerCustomerId;
      const customer = await this.provider.createCustomer(user);
      account ||= repo.create({ userId: user.id, providerCustomerId: null, provider: "stripe", mode: "test" });
      account.providerCustomerId = customer.id;
      account.provider = "stripe";
      account.mode = "test";
      await repo.save(account);
      return customer.id;
    });
  }

  private async processCheckoutCompleted(manager: EntityManager, session: Stripe.Checkout.Session, occurredAt: Date) {
    const checkoutRepo = manager.getRepository(BillingCheckoutSession);
    const checkout = await checkoutRepo.findOne({ where: { providerSessionId: session.id } });
    if (!checkout) throw new BadRequestException("Stripe Checkout Session does not match a DeployGuard checkout.");
    const customerId = this.objectId(session.customer);
    const subscriptionId = this.objectId(session.subscription);
    if (!customerId || !subscriptionId || customerId !== checkout.providerCustomerId) throw new BadRequestException("Stripe Checkout customer or subscription identity does not match DeployGuard.");
    const account = await manager.getRepository(BillingAccount).findOne({ where: { userId: checkout.userId } });
    if (account?.providerCustomerId !== customerId) throw new BadRequestException("Stripe Checkout customer does not belong to the DeployGuard account.");
    const subscription = await this.provider.retrieveSubscription(subscriptionId);
    if (this.objectId(subscription.customer) !== customerId) throw new BadRequestException("Stripe subscription customer does not match Checkout.");
    const applied = await this.applySubscription(manager, subscription, occurredAt, false);
    if (applied.userId !== checkout.userId || applied.plan !== checkout.plan) throw new BadRequestException("Stripe subscription plan or account does not match Checkout.");
    checkout.providerSubscriptionId = subscription.id;
    checkout.status = "completed";
    await checkoutRepo.save(checkout);
    return { received: true, duplicate: false, status: "subscription_verified" };
  }

  private async processSubscriptionEvent(manager: EntityManager, eventType: string, supplied: Stripe.Subscription, occurredAt: Date) {
    const deleted = eventType === "customer.subscription.deleted";
    const subscription = deleted ? supplied : await this.provider.retrieveSubscription(supplied.id);
    const applied = await this.applySubscription(manager, subscription, occurredAt, deleted);
    return { received: true, duplicate: false, status: applied.stale ? "stale_ignored" : subscription.status };
  }

  private async processInvoiceEvent(manager: EntityManager, eventType: string, invoice: Stripe.Invoice, occurredAt: Date) {
    const subscriptionId = this.invoiceSubscriptionId(invoice);
    if (!subscriptionId) throw new BadRequestException("Stripe invoice is not linked to a subscription.");
    const subscription = await this.provider.retrieveSubscription(subscriptionId);
    const applied = await this.applySubscription(manager, subscription, occurredAt, false);
    const customerId = this.objectId(invoice.customer);
    if (!customerId || customerId !== applied.customerId) throw new BadRequestException("Stripe invoice customer does not match its DeployGuard subscription.");
    const paid = eventType === "invoice.paid";
    await this.persistInvoice(manager, invoice, applied, paid, occurredAt);
    return { received: true, duplicate: false, status: paid ? "paid" : "payment_failed" };
  }

  private async applySubscription(manager: EntityManager, subscription: Stripe.Subscription, occurredAt: Date, deletedEvent: boolean) {
    if (subscription.livemode) throw new BadRequestException("Stripe live-mode subscriptions are not accepted.");
    const customerId = this.objectId(subscription.customer);
    if (!customerId) throw new BadRequestException("Stripe subscription is missing its customer.");
    const account = await manager.getRepository(BillingAccount).findOne({ where: { providerCustomerId: customerId } });
    if (!account) throw new BadRequestException("Stripe customer is not linked to a DeployGuard account.");
    const items = subscription.items?.data || [];
    const supported = items.map((item) => ({ item, plan: this.provider.planForPrice(item.price.id) })).filter((entry) => entry.plan);
    if (items.length !== 1 || supported.length !== 1) throw new BadRequestException("Stripe subscription must contain exactly one configured DeployGuard Price.");
    const plan = supported[0].plan!;
    const item = supported[0].item;
    const repo = manager.getRepository(BillingSubscription);
    let row = await repo.findOne({ where: { userId: account.userId } });
    row ||= repo.create({ userId: account.userId, plan: "free", status: "active", provider: "none", mode: "not_configured" });
    if (row.providerSubscriptionId && row.providerSubscriptionId !== subscription.id && !TERMINAL_SUBSCRIPTION_STATUSES.has(row.status)) {
      throw new BadRequestException("Stripe subscription conflicts with the account's existing subscription.");
    }
    if (deletedEvent && row.providerEventCreatedAt && row.providerEventCreatedAt.getTime() > occurredAt.getTime()) {
      return { row, plan: row.plan as BillingPlan, userId: row.userId, customerId, stale: true, periodStart: row.billingPeriodStart, periodEnd: row.billingPeriodEnd };
    }
    row.providerSubscriptionId = subscription.id;
    row.providerPriceId = item.price.id;
    row.plan = plan;
    row.status = subscription.status;
    row.provider = "stripe";
    row.mode = "test";
    row.billingPeriodStart = item.current_period_start ? new Date(item.current_period_start * 1000) : null;
    row.billingPeriodEnd = item.current_period_end ? new Date(item.current_period_end * 1000) : null;
    row.cancelAtPeriodEnd = subscription.cancel_at_period_end;
    row.cancelledAt = subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : null;
    row.endedAt = subscription.ended_at ? new Date(subscription.ended_at * 1000) : null;
    if (!row.providerEventCreatedAt || row.providerEventCreatedAt.getTime() <= occurredAt.getTime()) row.providerEventCreatedAt = occurredAt;
    await repo.save(row);
    return { row, plan, userId: row.userId, customerId, stale: false, periodStart: row.billingPeriodStart, periodEnd: row.billingPeriodEnd };
  }

  private async persistInvoice(manager: EntityManager, invoice: Stripe.Invoice, applied: Awaited<ReturnType<BillingService["applySubscription"]>>, paid: boolean, occurredAt: Date) {
    const invoiceRepo = manager.getRepository(BillingInvoice);
    let row = await invoiceRepo.findOne({ where: { providerInvoiceId: invoice.id } });
    row ||= invoiceRepo.create({
      userId: applied.userId,
      providerInvoiceId: invoice.id,
      invoiceNumber: invoice.number || `STRIPE-${invoice.id}`,
      providerTransactionId: null,
      provider: "stripe", mode: "test", plan: applied.plan, status: invoice.status || (paid ? "paid" : "open"),
      amountDue: invoice.amount_due, currency: invoice.currency.toUpperCase(),
      hostedInvoiceUrl: invoice.hosted_invoice_url || null, invoicePdfUrl: invoice.invoice_pdf || null,
      issuedAt: invoice.created ? new Date(invoice.created * 1000) : occurredAt,
      paidAt: null, billingPeriodStart: applied.periodStart, billingPeriodEnd: applied.periodEnd,
      subscriptionStatus: applied.row.status, invalidatedAt: null, invalidationReason: null, providerEventCreatedAt: occurredAt,
    });
    row.plan = applied.plan;
    row.status = paid ? "paid" : "payment_failed";
    row.amountDue = invoice.amount_due;
    row.currency = invoice.currency.toUpperCase();
    row.hostedInvoiceUrl = invoice.hosted_invoice_url || null;
    row.invoicePdfUrl = invoice.invoice_pdf || null;
    row.billingPeriodStart = applied.periodStart;
    row.billingPeriodEnd = applied.periodEnd;
    row.subscriptionStatus = applied.row.status;
    row.providerEventCreatedAt = occurredAt;
    if (paid) {
      const transactionReference = `invoice:${invoice.id}`;
      row.providerTransactionId = transactionReference;
      row.paidAt = invoice.status_transitions?.paid_at ? new Date(invoice.status_transitions.paid_at * 1000) : occurredAt;
      const paymentRepo = manager.getRepository(BillingPayment);
      const existing = await paymentRepo.findOne({ where: { providerTransactionId: transactionReference } });
      if (!existing) await paymentRepo.save(paymentRepo.create({
        userId: applied.userId, providerTransactionId: transactionReference, checkoutSessionId: null,
        provider: "stripe", mode: "test", plan: applied.plan, status: "paid",
        amount: invoice.amount_paid || invoice.amount_due, currency: invoice.currency.toUpperCase(), paidAt: row.paidAt,
        safeMetadata: { providerInvoiceId: invoice.id, providerSubscriptionId: applied.row.providerSubscriptionId },
      }));
    }
    await invoiceRepo.save(row);
  }

  private async ensureSubscription(userId: number, manager?: EntityManager) {
    const repo = manager?.getRepository(BillingSubscription) || this.subscriptionRepo;
    let subscription = await repo.findOne({ where: { userId } });
    if (!subscription) subscription = await repo.save(repo.create({ userId, plan: "free", status: "active", provider: "none", mode: "not_configured" }));
    return subscription;
  }

  private invoiceSubscriptionId(invoice: Stripe.Invoice) {
    const modern = invoice.parent?.subscription_details?.subscription;
    return this.objectId(modern) || this.objectId((invoice as Stripe.Invoice & { subscription?: string | Stripe.Subscription | null }).subscription);
  }

  private objectId(value: unknown): string | null {
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && "id" in value && typeof (value as { id?: unknown }).id === "string") return (value as { id: string }).id;
    return null;
  }

  private webhookMetadata(object: Stripe.Event.Data.Object) {
    const source = object as unknown as { id?: string; customer?: unknown; subscription?: unknown };
    return { objectId: source.id || null, customerId: this.objectId(source.customer), subscriptionId: this.objectId(source.subscription) };
  }

  private trialView(subscription: BillingSubscription) {
    const now = Date.now();
    const ends = subscription.trialEndsAt?.getTime() || null;
    return { startedAt: subscription.trialStartedAt, endsAt: subscription.trialEndsAt, projectId: subscription.trialProjectId, expired: Boolean(ends && ends <= now), remainingSeconds: ends ? Math.max(0, Math.floor((ends - now) / 1000)) : null, hours: PLAN_ENTITLEMENTS.free.freeTrialHours };
  }

  private invoiceView(invoice: BillingInvoice) {
    return { id: invoice.id, invoiceNumber: invoice.invoiceNumber, plan: invoice.plan, status: invoice.status, amountDue: invoice.amountDue, currency: invoice.currency, provider: invoice.provider, mode: invoice.mode, providerTransactionId: invoice.providerTransactionId, hostedInvoiceUrl: invoice.hostedInvoiceUrl, invoicePdfUrl: invoice.invoicePdfUrl, issuedAt: invoice.issuedAt, paidAt: invoice.paidAt, billingPeriodStart: invoice.billingPeriodStart, billingPeriodEnd: invoice.billingPeriodEnd, subscriptionStatus: invoice.subscriptionStatus };
  }
}
