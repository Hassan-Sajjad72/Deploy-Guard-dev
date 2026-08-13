import { forwardRef, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { Project } from "../projects/project.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { BillingAccount } from "./billing-account.entity";
import { BillingCheckoutSession } from "./billing-checkout-session.entity";
import { BillingInvoice } from "./billing-invoice.entity";
import { BillingProviderService } from "./billing-provider.service";
import { BillingService } from "./billing.service";
import { BillingSubscription } from "./billing-subscription.entity";
import { BillingUsageCounter } from "./billing-usage-counter.entity";
import { BillingUsageEvent } from "./billing-usage-event.entity";
import { BillingWebhookEvent } from "./billing-webhook-event.entity";
import { EntitlementService } from "./entitlement.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { ProjectUsageService } from "./project-usage.service";

@Module({
  imports: [TypeOrmModule.forFeature([Project, ProjectPipelineRun, BillingAccount, BillingSubscription, BillingUsageCounter, BillingUsageEvent, BillingCheckoutSession, BillingInvoice, BillingWebhookEvent]), AuditLogModule, forwardRef(() => NotificationsModule)],
  providers: [BillingProviderService, ProjectUsageService, EntitlementService, BillingService],
  exports: [ProjectUsageService, EntitlementService, BillingService],
})
export class BillingModule {}
