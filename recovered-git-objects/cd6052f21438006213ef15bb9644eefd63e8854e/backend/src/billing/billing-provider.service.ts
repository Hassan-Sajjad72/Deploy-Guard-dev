import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Stripe from "stripe";
import { User } from "../users/user.entity";

export type ProviderCheckout = {
  id: string;
  url: string | null;
  expiresAt: Date | null;
  provider: "stripe";
  mode: "live";
};

@Injectable()
export class BillingProviderService {
  constructor(private readonly config: ConfigService) {}

  status() {
    const required = ["STRIPE_SECRET_KEY", "STRIPE_PRO_PRICE_ID"] as const;
    const missingConfiguration = required.filter((key) => !this.config.get<string>(key)?.trim());
    const configured = missingConfiguration.length === 0;
    return {
      provider: configured ? "stripe" : "none",
      mode: configured ? "live" : "not_configured",
      configured,
      missingConfiguration,
      webhookConfigured: Boolean(this.config.get<string>("STRIPE_WEBHOOK_SECRET")?.trim()),
    } as const;
  }

  async createCheckout(user: User): Promise<ProviderCheckout> {
    const status = this.status();
    if (!status.configured) {
      throw new BadRequestException(`NOT_CONFIGURED: missing ${status.missingConfiguration.join(", ")}`);
    }
    const frontend = this.config.get<string>("FRONTEND_URL", "http://localhost:5173").replace(/\/$/, "");
    const session = await this.stripe().checkout.sessions.create({
      mode: "subscription",
      customer_email: user.email || undefined,
      client_reference_id: String(user.id),
      line_items: [{ price: this.config.get<string>("STRIPE_PRO_PRICE_ID")!, quantity: 1 }],
      success_url: `${frontend}/billing?checkout=success`,
      cancel_url: `${frontend}/billing?checkout=cancelled`,
      metadata: { deployguardUserId: String(user.id), plan: "pro" },
    });
    return { id: session.id, url: session.url, expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : null, provider: "stripe", mode: "live" };
  }

  async createPortal(customerId: string) {
    if (!this.status().configured) throw new BadRequestException(`NOT_CONFIGURED: missing ${this.status().missingConfiguration.join(", ")}`);
    const frontend = this.config.get<string>("FRONTEND_URL", "http://localhost:5173").replace(/\/$/, "");
    return this.stripe().billingPortal.sessions.create({ customer: customerId, return_url: `${frontend}/billing` });
  }

  async cancelAtPeriodEnd(subscriptionId: string) {
    if (!this.status().configured) throw new BadRequestException(`NOT_CONFIGURED: missing ${this.status().missingConfiguration.join(", ")}`);
    return this.stripe().subscriptions.update(subscriptionId, { cancel_at_period_end: true });
  }

  verifyWebhook(rawBody: Buffer, signature: string) {
    const secret = this.config.get<string>("STRIPE_WEBHOOK_SECRET");
    if (!this.status().configured || !secret) throw new BadRequestException("Stripe webhook verification is not configured.");
    return this.stripe().webhooks.constructEvent(rawBody, signature, secret);
  }

  private stripe() {
    return new Stripe(this.config.get<string>("STRIPE_SECRET_KEY")!);
  }
}
