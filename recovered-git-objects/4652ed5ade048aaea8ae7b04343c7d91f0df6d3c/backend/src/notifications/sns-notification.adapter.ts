import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PublishCommand, SNSClient, SubscribeCommand, UnsubscribeCommand } from "@aws-sdk/client-sns";

@Injectable()
export class SnsNotificationAdapter {
  constructor(private readonly config: ConfigService) {}
  status() { const configured = Boolean(this.topicArn()); return { configured, mode: configured ? "live" : "unavailable", region: this.config.get<string>("SNS_REGION", this.config.get<string>("AWS_REGION", "us-east-1")) }; }
  async subscribe(email: string, userId: number) {
    if (!this.status().configured) return { status: "skipped_unconfigured", subscriptionArn: null };
    const response = await this.client().send(new SubscribeCommand({ TopicArn: this.topicArn(), Protocol: "email", Endpoint: email, ReturnSubscriptionArn: true, Attributes: { FilterPolicy: JSON.stringify({ deployguardUserId: [String(userId)] }) } }));
    const arn = response.SubscriptionArn || null;
    return { status: arn === "pending confirmation" ? "pending_confirmation" : "confirmed", subscriptionArn: arn };
  }
  async unsubscribe(arn: string | null) { if (arn && arn !== "pending confirmation" && this.status().configured) await this.client().send(new UnsubscribeCommand({ SubscriptionArn: arn })); }
  async send(userId: number, subject: string, message: string) {
    if (!this.status().configured) return { status: "skipped_unconfigured", messageId: null };
    const response = await this.client().send(new PublishCommand({ TopicArn: this.topicArn(), Subject: subject.slice(0, 100), Message: message, MessageAttributes: { deployguardUserId: { DataType: "String", StringValue: String(userId) } } }));
    return { status: "sent", messageId: response.MessageId || null };
  }
  private client() { return new SNSClient({ region: this.config.get<string>("SNS_REGION", this.config.get<string>("AWS_REGION", "us-east-1")) }); }
  private topicArn() { return this.config.get<string>("SNS_TOPIC_ARN", "").trim(); }
}
