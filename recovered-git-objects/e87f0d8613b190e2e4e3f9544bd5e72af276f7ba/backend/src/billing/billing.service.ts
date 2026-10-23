import { BadRequestException, forwardRef, Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Request } from "express";
import { Repository } from "typeorm";
import Stripe from "stripe";
import { AuditLogService } from "../audit-log/audit-log.service";
import { User } from "../users/user.entity";
import { NotificationDispatcherService } from "../notifications/notification-dispatcher.service";
import { BillingAccount } from "./billing-account.entity";
import { BillingCheckoutSession } from "./billing-checkout-session.entity";
import { BillingInvoice } from "./billing-invoice.entity";
import { BillingProviderService } from "./billing-provider.service";
import { BillingSubscription } from "./billing-subscription.entity";
import { BillingWebhookEvent } from "./billing-webhook-event.entity";
import { EntitlementService } from "./entitlement.service";
import { ProjectUsageService } from "./project-usage.service";

@Injectable()
export class BillingService {
  constructor(
    @InjectRepository(BillingAccount) private readonly accountRepo: Repository<BillingAccount>,
    @InjectRepository(BillingSubscription) private readonly subscriptionRepo: Repository<BillingSubscription>,
    @InjectRepository(BillingCheckoutSession) private readonly checkoutRepo: Repository<BillingCheckoutSession>,
    @InjectRepository(BillingInvoice) private readonly invoiceRepo: Repository<BillingInvoice>,
    @InjectRepository(BillingWebhookEvent) private readonly webhookRepo: Repository<BillingWebhookEvent>,
    private readonly provider: BillingProviderService,
    private readonly entitlements: EntitlementService,
    private readonly projectUsage: ProjectUsageService,
    private readonly auditLog: AuditLogService,
    @Inject(forwardRef(() => NotificationDispatcherService)) private readonly notifications: NotificationDispatcherService
  ) {}

  async summary(user: User) {
    const [account, subscription, invoices] = await Promise.all([
      this.accountRepo.findOne({ where: { userId: user.id } }),
      this.ensureSubscription(user.id),
      this.invoiceRepo.find({ where: { userId: user.id }, order: { createdAt: "DESC" }, take: 25 }),
    ]);
    const provider = this.provider.status();
    if (!provider.configured && subscription.mode === "demo") {
      subscription.plan = "free";
      subscription.provider = "none";
      subscription.mode = "not_configured";
      subscription.cancelAtPeriodEnd = false;
      await this.subscriptionRepo.save(subscription);
    }
    const usage = await this.entitlements.usage(user.id);
    const projectUsage = await this.entitlements.projectUsage(user.id);
    const deploymentRuns = await this.projectUsage.deploymentRunsSince(user.id, new Date(usage.periodStart));
    const workspaceUsage = {
      ...projectUsage,
      deploymentRuns,
      limits: {
        activeProjects: usage.enforcement.enabled ? projectUsage.projectLimit : null,
        deploymentRuns: null,
      },
    };
    return {
      provider,
      enforcement: usage.enforcement,
      plan: subscription.plan,
      status: subscription.status,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      billingPeriodStart: subscription.billingPeriodStart,
      billingPeriodEnd: subscription.billingPeriodEnd,
      entitlements: usage.entitlements,
      usage: usage.usage,
      usagePeriod: { start: usage.periodStart, end: usage.periodEnd },
      workspaceUsage,
      paymentMethod: account?.paymentLast4 ? { brand: account.paymentBrand, last4: account.paymentLast4, expMonth: account.paymentExpMonth, expYear: account.paymentExpYear } : null,
      invoices: invoices.map((invoice) => ({ id: invoice.id, status: invoice.status, amountDue: invoice.amountDue, currency: invoice.currency, hostedInvoiceUrl: invoice.hostedInvoiceUrl, invoicePdfUrl: invoice.invoicePdfUrl, issuedAt: invoice.issuedAt })),
    };
  }

  async createCheckout(user: User, req?: Request) {
    const checkout = await this.provider.createCheckout(user);
    await this.checkoutRepo.save(this.checkoutRepo.create({ userId: user.id, providerSessionId: checkout.id, provider: checkout.provider, mode: checkout.mode, plan: "pro", status: "created", expiresAt: checkout.expiresAt }));
    await this.auditLog.record({ actorUser: user, action: "BILLING_CHECKOUT_CREATED", resourceType: "billing", resourceId: checkout.id, status: "success", metadata: { provider: checkout.provider, mode: checkout.mode, plan: "pro" }, req });
    return { checkoutUrl: checkout.url, checkoutSessionId: checkout.id, provider: checkout.provider, mode: checkout.mode, message: "Hosted checkout created." };
  }

  async portal(user: User) {
    const account = await this.accountRepo.findOne({ where: { userId: user.id } });
    if (!account?.providerCustomerId) throw new BadRequestException("No live billing customer is available.");
    const portal = await this.provider.createPortal(account.providerCustomerId);
    return { url: portal.url, mode: "live" };
  }

  async setDemoPlan(user: User, plan: "free" | "pro", req?: Request) {
    void user; void plan; void req;
    throw new BadRequestException("Demo billing is disabled.");
  }

  async cancel(user: User, req?: Request) {
    const subscription = await this.ensureSubscription(user.id);
    if (subscription.mode !== "live" || !subscription.providerSubscriptionId) throw new BadRequestException("No live provider subscription is available.");
    await this.provider.cancelAtPeriodEnd(subscription.providerSubscriptionId);
    subscription.cancelAtPeriodEnd = true;
    await this.subscriptionRepo.save(subscription);
    await this.auditLog.record({ actorUser: user, action: "BILLING_CANCELLATION_REQUESTED", resourceType: "billing", resourceId: subscription.id, status: "success", metadata: { mode: subscription.mode, cancelAtPeriodEnd: subscription.cancelAtPeriodEnd }, req });
    return this.summary(user);
  }

  async handleStripeWebhook(rawBody: Buffer, signature: string) {
    const event = this.provider.verifyWebhook(rawBody, signature);
    let row = await this.webhookRepo.findOne({ where: { providerEventId: event.id } });
    const duplicate = Boolean(row);
    if (row?.status === "processed") return { received: true, duplicate: true };
    if (!row) {
      try {
        row = await this.webhookRepo.save(this.webhookRepo.create({ providerEventId: event.id, provider: "stripe", eventType: event.type, status: "received", occurredAt: new Date(event.created * 1000), safeMetadata: { livemode: event.livemode } }));
      } catch (error) {
        if (String((error as { code?: unknown }).code) !== "23505") throw error;
        row = await this.webhookRepo.findOne({ where: { providerEventId: event.id } });
        if (!row) throw error;
        if (row.status === "processed") return { received: true, duplicate: true };
      }
    }
    try {
      await this.applyStripeEvent(event);
      row.status = "processed";
      row.processedAt = new Date();
      row.safeMetadata = { ...(row.safeMetadata || {}), livemode: event.livemode };
      await this.webhookRepo.save(row);
      return { received: true, duplicate };
    } catch (error) {
      row.status = "failed";
      row.safeMetadata = { ...(row.safeMetadata || {}), livemode: event.livemode, errorType: error instanceof Error ? error.name : "WebhookProcessingError" };
      await this.webhookRepo.save(row);
      throw error;
    }
  }

  private async applyStripeEvent(event: Stripe.Event) {
    if (event.type.startsWith("customer.subscription.")) {
      const object = event.data.object as Stripe.Subscription;
      const account = await this.accountRepo.findOne({ where: { providerCustomerId: String(object.customer) } });
      if (!account) return;
      const subscription = await this.ensureSubscription(account.userId);
      const eventCreatedAt = new Date(event.created * 1000);
      if (subscription.providerEventCreatedAt && subscription.providerEventCreatedAt > eventCreatedAt) return;
      subscription.providerSubscriptionId = object.id;
      subscription.provider = "stripe";
      subscription.mode = "live";
      subscription.plan = ["trialing", "active", "past_due"].includes(object.status) ? "pro" : "free";
      subscription.status = object.status === "canceled" ? "cancelled" : object.status;
      subscription.cancelAtPeriodEnd = object.cancel_at_period_end;
      subscription.providerEventCreatedAt = eventCreatedAt;
      const current = object.items.data[0] as Stripe.SubscriptionItem & { current_period_start?: number; current_period_end?: number };
      subscription.billingPeriodStart = current?.current_period_start ? new Date(current.current_period_start * 1000) : null;
      subscription.billingPeriodEnd = current?.current_period_end ? new Date(current.current_period_end * 1000) : null;
      await this.subscriptionRepo.save(subscription);
    }
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = Number(session.client_reference_id || session.metadata?.deployguardUserId);
      if (!userId) return;
      let account = await this.accountRepo.findOne({ where: { userId } });
      account ||= this.accountRepo.create({ userId });
      account.providerCustomerId = session.customer ? String(session.customer) : account.providerCustomerId;
      account.provider = "stripe"; account.mode = "live";
      await this.accountRepo.save(account);
    }
    if (event.type === "invoice.payment_failed" || event.type === "invoice.paid") {
      const invoice = event.data.object as Stripe.Invoice;
      const account = invoice.customer ? await this.accountRepo.findOne({ where: { providerCustomerId: String(invoice.customer) } }) : null;
      if (!account) return;
      let row = await this.invoiceRepo.findOne({ where: { providerInvoiceId: invoice.id } });
      row ||= this.invoiceRepo.create({ userId: account.userId, providerInvoiceId: invoice.id });
      const eventCreatedAt = new Date(event.created * 1000);
      if (row.providerEventCreatedAt && row.providerEventCreatedAt > eventCreatedAt) return;
      row.status = event.type === "invoice.payment_failed" ? "payment_failed" : "paid";
      row.amountDue = invoice.amount_due || 0; row.currency = invoice.currency || "usd"; row.hostedInvoiceUrl = invoice.hosted_invoice_url || null; row.invoicePdfUrl = invoice.invoice_pdf || null; row.issuedAt = invoice.created ? new Date(invoice.created * 1000) : null;
      row.providerEventCreatedAt = eventCreatedAt;
      await this.invoiceRepo.save(row);
      if (event.type === "invoice.payment_failed") { const subscription = await this.ensureSubscription(account.userId); subscription.status = "past_due"; await this.subscriptionRepo.save(subscription); await this.notifications.dispatchAccount(account.userId, event.id, "billing_payment_failed", "A DeployGuard subscription payment failed. Open Plan & Usage to review the provider-hosted invoice."); await this.auditLog.record({ action: "BILLING_PAYMENT_FAILED", resourceType: "billing", resourceId: row.id, status: "failed", metadata: { provider: "stripe", invoiceStatus: row.status } }); }
    }
  }

  private async ensureSubscription(userId: number) {
    let subscription = await this.subscriptionRepo.findOne({ where: { userId } });
    if (!subscription) subscription = await this.subscriptionRepo.save(this.subscriptionRepo.create({ userId, plan: "free", status: "active", provider: "none", mode: "not_configured" }));
    return subscription;
  }

}
