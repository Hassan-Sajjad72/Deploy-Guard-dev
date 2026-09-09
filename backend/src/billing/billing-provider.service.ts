import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "crypto";
import Stripe = require("stripe");
import { User } from "../users/user.entity";
import { BillingPlan } from "./billing-plan";
import { getBillingConfig } from "./billing.config";

export type StripeCheckout = {
  id: string;
  url: string;
  customerId: string;
  priceId: string;
  expiresAt: Date | null;
  provider: "stripe";
  mode: "test";
};

export type VerifiedStripeEvent = {
  eventId: string;
  eventType: string;
  object: Stripe.Event.Data.Object;
  occurredAt: Date;
};

@Injectable()
export class BillingProviderService {
  private stripeClient?: Stripe;

  constructor(private readonly config: ConfigService) {}

  status() {
    const billing = getBillingConfig(this.config);
    const required = [
      "STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET",
      "STRIPE_PRO_PRICE_ID", "STRIPE_PRO_PLUS_PRICE_ID", "FRONTEND_URL",
    ] as const;
    const missingConfiguration = required.filter((key) => !this.config.get<string>(key)?.trim());
    const configurationErrors = this.configurationErrors();
    const configured = billing.enabled && missingConfiguration.length === 0 && configurationErrors.length === 0;
    return {
      provider: "stripe" as const, mode: "test" as const, enabled: billing.enabled, configured,
      missingConfiguration, configurationErrors,
      webhookConfigured: billing.enabled && /^whsec_/.test(this.config.get<string>("STRIPE_WEBHOOK_SECRET")?.trim() || ""),
    };
  }

  async createCustomer(user: User) {
    const status = this.status();
    if (!status.configured) throw new BadRequestException(this.unavailableMessage(status));
    const existing = await this.stripe().customers.search({ query: `metadata['deployguardUserId']:'${user.id}'`, limit: 2 });
    if (existing.data.length > 1) throw new BadRequestException("Multiple Stripe customers are linked to this DeployGuard account; resolve the sandbox customer identity before checkout.");
    if (existing.data[0]) return existing.data[0];
    return this.stripe().customers.create({
      email: user.email || undefined,
      name: user.name || undefined,
      metadata: { deployguardUserId: String(user.id), deployguardEnvironment: "test" },
    }, { idempotencyKey: `deployguard-customer-${user.id}` });
  }

  async createCheckout(orderId: string, plan: Exclude<BillingPlan, "free">, user: User, customerId: string): Promise<StripeCheckout> {
    const status = this.status();
    if (!status.configured) throw new BadRequestException(this.unavailableMessage(status));
    const frontend = this.frontendUrl();
    const priceId = this.priceIdForPlan(plan);
    const metadata = {
      deployguardUserId: String(user.id), deployguardPlan: plan,
      deployguardOrderId: orderId, deployguardAction: "plan_upgrade",
    };
    const session = await this.stripe().checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: String(user.id),
      success_url: `${frontend}/billing?checkout=returned&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontend}/billing?checkout=cancelled`,
      line_items: [{ quantity: 1, price: priceId }],
      metadata,
      subscription_data: { metadata },
      integration_identifier: `deployguard_${this.randomLetters(8)}`,
    }, { idempotencyKey: orderId });
    if (!session.url) throw new BadRequestException("Stripe test Checkout did not return a hosted URL.");
    return {
      id: session.id, url: session.url, customerId, priceId,
      expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : null,
      provider: "stripe", mode: "test",
    };
  }

  async retrieveSubscription(subscriptionId: string) {
    return this.stripe().subscriptions.retrieve(subscriptionId, { expand: ["items.data.price"] });
  }

  async createPortal(customerId: string) {
    const status = this.status();
    if (!status.configured) throw new BadRequestException(this.unavailableMessage(status));
    return this.stripe().billingPortal.sessions.create({ customer: customerId, return_url: `${this.frontendUrl()}/billing` });
  }

  verifyWebhook(rawBody: Buffer, signature: string): VerifiedStripeEvent {
    const status = this.status();
    if (!status.configured || !status.webhookConfigured) throw new BadRequestException(this.unavailableMessage(status));
    if (!signature.trim() || !rawBody.length) throw new UnauthorizedException("Invalid Stripe webhook signature.");
    let event: Stripe.Event;
    try {
      event = this.stripe().webhooks.constructEvent(rawBody, signature, this.config.get<string>("STRIPE_WEBHOOK_SECRET")!);
    } catch {
      throw new UnauthorizedException("Invalid Stripe webhook signature.");
    }
    if (event.livemode) throw new UnauthorizedException("Stripe live-mode events are not accepted while BILLING_MODE=test.");
    return { eventId: event.id, eventType: event.type, object: event.data.object, occurredAt: new Date(event.created * 1000) };
  }

  priceIdForPlan(plan: Exclude<BillingPlan, "free">) {
    const key = plan === "pro" ? "STRIPE_PRO_PRICE_ID" : "STRIPE_PRO_PLUS_PRICE_ID";
    const value = this.config.get<string>(key)?.trim() || "";
    if (!/^price_[A-Za-z0-9]+$/.test(value)) throw new BadRequestException(`NOT_CONFIGURED: ${key} must be a Stripe Price ID.`);
    return value;
  }

  planForPrice(priceId: string): Exclude<BillingPlan, "free"> | null {
    if (priceId === this.config.get<string>("STRIPE_PRO_PRICE_ID")?.trim()) return "pro";
    if (priceId === this.config.get<string>("STRIPE_PRO_PLUS_PRICE_ID")?.trim()) return "pro_plus";
    return null;
  }

  private stripe() { return this.stripeClient ||= new Stripe(this.config.get<string>("STRIPE_SECRET_KEY")!); }

  private frontendUrl() {
    const raw = this.config.get<string>("FRONTEND_URL")?.trim();
    if (!raw) throw new BadRequestException("NOT_CONFIGURED: missing FRONTEND_URL");
    let url: URL;
    try { url = new URL(raw); } catch { throw new BadRequestException("FRONTEND_URL must be an absolute HTTP or HTTPS URL."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new BadRequestException("FRONTEND_URL must be an absolute HTTP or HTTPS URL without credentials, query, or fragment.");
    return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  }

  private configurationErrors() {
    const errors: string[] = [];
    const secret = this.config.get<string>("STRIPE_SECRET_KEY")?.trim() || "";
    const publishable = this.config.get<string>("STRIPE_PUBLISHABLE_KEY")?.trim() || "";
    const webhook = this.config.get<string>("STRIPE_WEBHOOK_SECRET")?.trim() || "";
    if (secret && !/^[sr]k_test_/.test(secret)) errors.push(/^[sr]k_live_/.test(secret) ? "STRIPE_SECRET_KEY must not be a live key while BILLING_MODE=test." : "STRIPE_SECRET_KEY must use a Stripe test-mode key.");
    if (publishable && !publishable.startsWith("pk_test_")) errors.push(publishable.startsWith("pk_live_") ? "STRIPE_PUBLISHABLE_KEY must not be a live key while BILLING_MODE=test." : "STRIPE_PUBLISHABLE_KEY must use the pk_test_ prefix.");
    if (webhook && !webhook.startsWith("whsec_")) errors.push("STRIPE_WEBHOOK_SECRET must use the whsec_ prefix.");
    for (const key of ["STRIPE_PRO_PRICE_ID", "STRIPE_PRO_PLUS_PRICE_ID"] as const) {
      const value = this.config.get<string>(key)?.trim() || "";
      if (value && !/^price_[A-Za-z0-9]+$/.test(value)) errors.push(`${key} must be a Stripe Price ID.`);
    }
    if (this.config.get<string>("FRONTEND_URL")?.trim()) {
      try { this.frontendUrl(); } catch (error) { errors.push(error instanceof Error ? error.message : "FRONTEND_URL is invalid."); }
    }
    return errors;
  }

  private unavailableMessage(status: ReturnType<BillingProviderService["status"]>) {
    if (!status.enabled) return "BILLING_DISABLED";
    if (status.configurationErrors.length) return `NOT_CONFIGURED: ${status.configurationErrors.join(" ")}`;
    return `NOT_CONFIGURED: missing ${status.missingConfiguration.join(", ")}`;
  }

  private randomLetters(length: number) {
    return Array.from(randomBytes(length), (value) => String.fromCharCode(97 + (value % 26))).join("");
  }
}
