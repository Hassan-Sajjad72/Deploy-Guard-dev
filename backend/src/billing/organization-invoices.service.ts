import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import { AdminAuthorizationService } from "../admin/admin-authorization.service";
import { assertInternalAdminScope } from "../admin/internal-admin-scope";
import { AuditLogService } from "../audit-log/audit-log.service";
import { User } from "../users/user.entity";
import { BillingInvoice } from "./billing-invoice.entity";
import { BillingPayment } from "./billing-payment.entity";
import { BillingSubscription } from "./billing-subscription.entity";
import { AdjustOrganizationInvoiceDto, ChangeOrganizationInvoiceDto, IssueOrganizationInvoiceDto, ReconcileOrganizationInvoiceDto } from "./dto/organization-invoice.dto";

@Injectable()
export class OrganizationInvoicesService {
  constructor(private readonly database: DataSource, private readonly authorization: AdminAuthorizationService, private readonly audit: AuditLogService) {}

  async workspaces(actor: User) {
    assertInternalAdminScope(actor, "billing");
    await this.authorization.requireRecentVerification(actor);
    await this.audit.record({ actorUser: actor, action: "ORGANIZATION_BILLING_DIRECTORY_VIEWED", resourceType: "billing", status: "success" });
    return this.database.query(`SELECT id, name, kind FROM organizations ORDER BY created_at LIMIT 1000`);
  }

  async list(actor: User, organizationId: string) {
    assertInternalAdminScope(actor, "billing");
    await this.authorization.requireRecentVerification(actor);
    await this.audit.record({ actorUser: actor, action: "ORGANIZATION_BILLING_VIEWED", resourceType: "organization", resourceId: organizationId, status: "success", metadata: { organizationId } });
    return this.database.getRepository(BillingInvoice).find({ where: { organizationId }, order: { createdAt: "DESC" }, take: 100 });
  }

  async issue(actor: User, dto: IssueOrganizationInvoiceDto) {
    await this.operator(actor, dto.reason);
    if (!Number.isSafeInteger(dto.amountDueCents) || dto.amountDueCents < 1 || dto.amountDueCents > 2147483647 || !["pro", "pro_plus"].includes(dto.plan)) throw new BadRequestException("A supported paid plan and positive invoice amount in USD cents are required.");
    const dueAt = new Date(dto.dueAt), start = new Date(dto.periodStart), end = new Date(dto.periodEnd);
    if (![dueAt, start, end].every((date) => Number.isFinite(date.getTime())) || end <= start) throw new BadRequestException("A valid billing period and invoice due date are required.");
    const result = await this.database.transaction(async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`billing-subscription:${dto.organizationId}`]);
      const invoiceRepo = manager.getRepository(BillingInvoice);
      const providerInvoiceId = `b2b:${dto.idempotencyKey}`;
      const existing = await invoiceRepo.findOneBy({ providerInvoiceId });
      if (existing) {
        if (existing.organizationId !== dto.organizationId || existing.amountDue !== dto.amountDueCents || existing.plan !== dto.plan
          || existing.dueAt?.getTime() !== dueAt.getTime() || existing.billingPeriodStart?.getTime() !== start.getTime() || existing.billingPeriodEnd?.getTime() !== end.getTime()) throw new ConflictException("Invoice identity belongs to a different request.");
        return { invoice: existing, duplicate: true };
      }
      if (dueAt < new Date()) throw new BadRequestException("A future invoice due date is required.");
      const [owner] = await manager.query(`SELECT membership.user_id FROM organization_memberships membership JOIN users ON users.id = membership.user_id WHERE membership.organization_id = $1 AND membership.role = 'owner' AND users.disabled_at IS NULL ORDER BY membership.user_id LIMIT 1`, [dto.organizationId]);
      if (!owner) throw new NotFoundException("Organization billing owner not found.");
      const subscriptions = manager.getRepository(BillingSubscription);
      let subscription = await subscriptions.findOneBy({ organizationId: dto.organizationId });
      if (subscription?.provider === "stripe" && !["canceled", "incomplete_expired", "unpaid"].includes(subscription.status)) throw new ConflictException("Manage the organization's existing Stripe subscription before using externally reconciled billing.");
      if (!subscription) subscription = await subscriptions.save(subscriptions.create({ userId: owner.user_id, organizationId: dto.organizationId, plan: "free", status: "active", provider: "none", mode: "not_configured" }));
      const invoice = await invoiceRepo.save(invoiceRepo.create({ userId: owner.user_id, organizationId: dto.organizationId,
        providerInvoiceId, invoiceNumber: `DG-B2B-${randomUUID()}`, provider: "b2b", mode: "externally_reconciled", plan: dto.plan,
        status: "open", amountDue: dto.amountDueCents, currency: "USD", issuedAt: new Date(), dueAt, billingPeriodStart: start, billingPeriodEnd: end,
        subscriptionStatus: subscription.status, reconciliationReason: dto.reason.trim() }));
      await this.audit.record({ actorUser: actor, action: "ORGANIZATION_INVOICE_ISSUED", resourceType: "organization", resourceId: dto.organizationId, status: "success", metadata: { organizationId: dto.organizationId, invoiceId: invoice.id, amountDueCents: dto.amountDueCents, currency: "USD", reason: dto.reason.trim() } }, manager);
      return { invoice, duplicate: false };
    });
    return result;
  }

  async reconcile(actor: User, organizationId: string, invoiceId: string, dto: ReconcileOrganizationInvoiceDto) {
    await this.operator(actor, dto.reason);
    const paidAt = new Date(dto.paidAt);
    if (!Number.isFinite(paidAt.getTime()) || paidAt.getTime() > Date.now()) throw new BadRequestException("External payment date must be an observed past or current date.");
    const reference = `b2b:${dto.externalPaymentReference.trim()}`;
    const result = await this.database.transaction(async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`billing-subscription:${organizationId}`]);
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`billing-payment:${reference}`]);
      const invoices = manager.getRepository(BillingInvoice);
      const invoice = await invoices.findOneBy({ id: invoiceId, organizationId, provider: "b2b" });
      if (!invoice) throw new NotFoundException("Organization B2B invoice not found.");
      if (dto.amountPaidCents !== invoice.amountDue) throw new BadRequestException("Full invoice amount in USD cents is required for reconciliation.");
      const payments = manager.getRepository(BillingPayment);
      const existing = await payments.findOneBy({ providerTransactionId: reference });
      if (existing) {
        if (existing.organizationId !== organizationId || existing.safeMetadata?.invoiceId !== invoiceId || existing.amount !== dto.amountPaidCents || existing.paidAt.getTime() !== paidAt.getTime()) throw new ConflictException("Payment reference belongs to a different receipt.");
        return { invoice, duplicate: true };
      }
      if (invoice.status !== "open") throw new ConflictException("Only an open B2B invoice can be reconciled.");
      const subscriptions = manager.getRepository(BillingSubscription);
      const subscription = await subscriptions.findOneBy({ organizationId });
      if (!subscription || (subscription.provider === "stripe" && !["canceled", "incomplete_expired", "unpaid"].includes(subscription.status))) throw new ConflictException("Subscription ownership or provider changed. Reconcile the billing account first.");
      const historicalReceipt = subscription.provider === "b2b" && subscription.billingPeriodStart && invoice.billingPeriodStart! < subscription.billingPeriodStart;
      await payments.save(payments.create({ userId: invoice.userId, organizationId, providerTransactionId: reference, provider: "b2b", mode: "externally_reconciled", plan: invoice.plan, status: "paid", amount: dto.amountPaidCents, currency: "USD", paidAt,
        safeMetadata: { invoiceId, reconciledByUserId: actor.id, reason: dto.reason.trim() } }));
      invoice.status = "paid"; invoice.paidAt = paidAt; invoice.providerTransactionId = reference; invoice.reconciliationReason = dto.reason.trim();
      if (!historicalReceipt) {
        subscription.provider = "b2b"; subscription.mode = "externally_reconciled"; subscription.plan = invoice.plan;
        subscription.status = invoice.billingPeriodEnd!.getTime() > Date.now() ? "active" : "expired";
        subscription.billingPeriodStart = invoice.billingPeriodStart; subscription.billingPeriodEnd = invoice.billingPeriodEnd;
        subscription.providerSubscriptionId = null; subscription.providerPriceId = null; subscription.cancelledAt = null; subscription.endedAt = null;
        await subscriptions.save(subscription);
      }
      invoice.subscriptionStatus = subscription.status;
      await invoices.save(invoice);
      await this.audit.record({ actorUser: actor, action: "ORGANIZATION_INVOICE_RECONCILED", resourceType: "organization", resourceId: organizationId, status: "success", metadata: { organizationId, invoiceId, amountPaidCents: dto.amountPaidCents, externalPaymentReference: dto.externalPaymentReference.trim(), reason: dto.reason.trim() } }, manager);
      return { invoice, duplicate: false };
    });
    return result;
  }

  async changeInvoice(actor: User, organizationId: string, invoiceId: string, dto: ChangeOrganizationInvoiceDto) {
    await this.operator(actor, dto.reason);
    await this.database.transaction(async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`billing-subscription:${organizationId}`]);
      const repo = manager.getRepository(BillingInvoice);
      const invoice = await repo.findOneBy({ id: invoiceId, organizationId, provider: "b2b" });
      if (!invoice) throw new NotFoundException("Organization B2B invoice not found.");
      if (dto.action === "void" && invoice.status !== "open") throw new ConflictException("Only an unpaid open invoice can be voided; receipts are retained.");
      if (dto.action === "dispute" && invoice.status !== "paid") throw new ConflictException("A paid invoice is required to record a payment dispute.");
      invoice.status = dto.action === "void" ? "void" : "disputed"; invoice.reconciliationReason = dto.reason.trim();
      await repo.save(invoice);
      await this.audit.record({ actorUser: actor, action: "ORGANIZATION_INVOICE_STATUS_CHANGED", resourceType: "organization", resourceId: organizationId, status: "success", metadata: { organizationId, invoiceId, action: dto.action, reason: dto.reason.trim() } }, manager);
    });
    return { updated: true };
  }

  async adjust(actor: User, organizationId: string, invoiceId: string, dto: AdjustOrganizationInvoiceDto) {
    await this.operator(actor, dto.reason);
    if (!Number.isSafeInteger(dto.amountDueCents) || dto.amountDueCents < 1 || dto.amountDueCents > 2147483647) throw new BadRequestException("A positive adjusted amount in USD cents is required.");
    const result = await this.database.transaction(async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`billing-subscription:${organizationId}`]);
      const repo = manager.getRepository(BillingInvoice);
      const original = await repo.findOneBy({ id: invoiceId, organizationId, provider: "b2b" });
      if (!original) throw new NotFoundException("Organization B2B invoice not found.");
      const providerInvoiceId = `b2b:${dto.idempotencyKey}`;
      const existing = await repo.findOneBy({ providerInvoiceId });
      if (existing) {
        if (existing.organizationId !== organizationId || existing.adjustmentOfInvoiceId !== invoiceId || existing.amountDue !== dto.amountDueCents) throw new ConflictException("Adjustment identity belongs to a different request.");
        return { invoice: existing, duplicate: true };
      }
      if (original.status !== "open" || original.providerTransactionId || original.paidAt) throw new ConflictException("Only an unpaid open invoice can be adjusted. Paid receipts require a separate external credit or dispute.");
      if (original.amountDue === dto.amountDueCents) throw new BadRequestException("The adjusted amount must differ from the original invoice.");
      const invoice = await repo.save(repo.create({ userId: original.userId, organizationId, providerInvoiceId,
        invoiceNumber: `DG-B2B-${randomUUID()}`, provider: "b2b", mode: original.mode, plan: original.plan, status: "open",
        amountDue: dto.amountDueCents, currency: original.currency, issuedAt: new Date(), dueAt: original.dueAt,
        billingPeriodStart: original.billingPeriodStart, billingPeriodEnd: original.billingPeriodEnd,
        subscriptionStatus: original.subscriptionStatus, reconciliationReason: dto.reason.trim(), adjustmentOfInvoiceId: original.id }));
      original.status = "void"; original.reconciliationReason = dto.reason.trim();
      await repo.save(original);
      await this.audit.record({ actorUser: actor, action: "ORGANIZATION_INVOICE_ADJUSTED", resourceType: "organization", resourceId: organizationId, status: "success", metadata: { organizationId, originalInvoiceId: invoiceId, invoiceId: invoice.id, amountDueCents: dto.amountDueCents, reason: dto.reason.trim() } }, manager);
      return { invoice, duplicate: false };
    });
    return result;
  }

  async cancel(actor: User, organizationId: string, reason: string) {
    await this.operator(actor, reason);
    await this.database.transaction(async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`billing-subscription:${organizationId}`]);
      const [rows] = await manager.query(`UPDATE billing_subscriptions SET status = 'canceled', cancelled_at = now(), ended_at = now(), updated_at = now() WHERE organization_id = $1 AND provider = 'b2b' AND status <> 'canceled' RETURNING id`, [organizationId]);
      if (!rows.length) throw new NotFoundException("Active organization B2B subscription not found.");
      await this.audit.record({ actorUser: actor, action: "ORGANIZATION_SUBSCRIPTION_CANCELLED", resourceType: "organization", resourceId: organizationId, status: "success", metadata: { organizationId, reason: reason.trim() } }, manager);
    });
    return { cancelled: true };
  }

  private async operator(actor: User, reason: string) {
    assertInternalAdminScope(actor, "billing");
    if (!reason?.trim() || reason.length > 1000) throw new BadRequestException("A billing action reason is required.");
    await this.authorization.requireRecentVerification(actor);
  }
}
