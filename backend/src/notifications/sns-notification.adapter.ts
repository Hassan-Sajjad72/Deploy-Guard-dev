import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CreateTopicCommand, DeleteTopicCommand, GetSubscriptionAttributesCommand, GetTopicAttributesCommand, ListSubscriptionsByTopicCommand, ListTagsForResourceCommand, PublishCommand, SNSClient, SubscribeCommand, UnsubscribeCommand } from "@aws-sdk/client-sns";

@Injectable()
export class SnsNotificationAdapter {
  constructor(private readonly config: ConfigService) {}
  status() {
    const enabled = this.config.get<unknown>("NOTIFICATION_DELIVERY_ENABLED") === "true";
    const accessKeyId = this.config.get<string>("AWS_ACCESS_KEY_ID", "").trim();
    const secretAccessKey = this.config.get<string>("AWS_SECRET_ACCESS_KEY", "").trim();
    const webIdentityTokenFile = this.config.get<string>("AWS_WEB_IDENTITY_TOKEN_FILE", "").trim();
    const roleArn = this.config.get<string>("AWS_ROLE_ARN", "").trim();
    const containerCredentials = this.config.get<string>("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", this.config.get<string>("AWS_CONTAINER_CREDENTIALS_FULL_URI", "")).trim();
    // DeployGuard's local/Compose contract supplies explicit AWS credentials;
    // deployed workloads may instead use the AWS web-identity or container
    // credential providers. Do not advertise a live provider if neither
    // contract is complete.
    const configured = enabled && Boolean(
      (accessKeyId && secretAccessKey)
      || (webIdentityTokenFile && roleArn)
      || containerCredentials,
    );
    return {
      enabled,
      configured,
      mode: configured ? "live" : enabled ? "unavailable" : "disabled",
      region: this.config.get<string>("SNS_REGION", this.config.get<string>("AWS_REGION", "us-east-1")),
    } as const;
  }
  async subscribe(email: string, userId: number, projectId: string) {
    if (!this.status().configured) return { status: "not_configured", subscriptionArn: null, topicArn: null };
    const topicArn = await this.ensureProjectTopic(projectId);
    const response = await this.client().send(new SubscribeCommand({ TopicArn: topicArn, Protocol: "email", Endpoint: email, ReturnSubscriptionArn: true, Attributes: { FilterPolicy: JSON.stringify({ deployguardUserId: [String(userId)], deployguardProjectId: [projectId] }) } }));
    const arn = response.SubscriptionArn || null;
    return { status: this.pending(arn) ? "pending_confirmation" : "confirmed", subscriptionArn: arn, topicArn };
  }
  async recreateSubscription(email: string, userId: number, projectId: string, topicArn: string | null) {
    if (!this.status().configured) return { status: "not_configured", subscriptionArn: null, topicArn: null };
    if (topicArn) await this.deleteOwnedProjectTopic(projectId, topicArn);
    return this.subscribe(email, userId, projectId);
  }
  async unsubscribe(arn: string | null, options: { idempotent?: boolean } = {}) {
    if (!arn || this.pending(arn) || !this.status().configured) return;
    try {
      await this.client().send(new UnsubscribeCommand({ SubscriptionArn: arn }));
    } catch (error) {
      // AWS can retain a PendingConfirmation subscription while the control
      // plane still has the ARN returned by an earlier subscribe call. During
      // project deletion neither form represents a deliverable subscription,
      // so it is already clean. Keep ordinary user unsubscribe fail-closed.
      if (options.idempotent && this.subscriptionAlreadyAbsentOrPending(error)) return;
      throw error;
    }
  }
  async findSubscription(email: string, userId: number, projectId: string, topicArn: string | null, expectedArn?: string | null) {
    if (!this.status().configured) return null;
    if (!topicArn) return null;
    let nextToken: string | undefined;
    do {
      const response = await this.client().send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn, NextToken: nextToken }));
      for (const candidate of response.Subscriptions || []) {
        if (candidate.Protocol !== "email" || candidate.Endpoint?.toLowerCase() !== email.toLowerCase() || !candidate.SubscriptionArn) continue;
        if (this.pending(candidate.SubscriptionArn)) continue;
        const attributes = await this.client().send(new GetSubscriptionAttributesCommand({ SubscriptionArn: candidate.SubscriptionArn }));
        let policy: Record<string, unknown> = {};
        try { policy = JSON.parse(attributes.Attributes?.FilterPolicy || "{}"); } catch { continue; }
        if (this.matchesFilter(policy, "deployguardUserId", String(userId)) && this.matchesFilter(policy, "deployguardProjectId", projectId)) {
          return { status: "confirmed", subscriptionArn: candidate.SubscriptionArn, topicArn, userId, projectId };
        }
      }
      nextToken = response.NextToken;
    } while (nextToken);
    if (expectedArn && this.pending(expectedArn)) return { status: "pending_confirmation", subscriptionArn: expectedArn, topicArn, userId, projectId };
    return null;
  }
  async send(userId: number, projectId: string, subject: string, message: string) {
    if (!this.status().configured) return { status: "skipped_unconfigured", messageId: null };
    const response = await this.client().send(new PublishCommand({ TopicArn: await this.ensureProjectTopic(projectId), Subject: subject.slice(0, 100), Message: message, MessageAttributes: { deployguardUserId: { DataType: "String", StringValue: String(userId) }, deployguardProjectId: { DataType: "String", StringValue: projectId } } }));
    return { status: "sent", messageId: response.MessageId || null };
  }
  async deleteProjectResources(projectId: string, subscriptions: Array<{ providerSubscriptionArn: string | null; providerTopicArn: string | null }>) {
    if (!this.status().configured) {
      if (subscriptions.some((item) => item.providerSubscriptionArn || item.providerTopicArn)) throw new Error("Project SNS cleanup is not configured.");
      return;
    }
    for (const subscription of subscriptions) {
      if (subscription.providerSubscriptionArn && this.pending(subscription.providerSubscriptionArn) && !subscription.providerTopicArn) {
        throw new Error("A project notification confirmation is still pending without an owned topic identity.");
      }
      await this.unsubscribe(subscription.providerSubscriptionArn, { idempotent: true });
    }
    const topics = [...new Set(subscriptions.map((item) => item.providerTopicArn).filter((value): value is string => Boolean(value)))];
    for (const topicArn of topics) await this.deleteOwnedProjectTopic(projectId, topicArn);
  }
  private async ensureProjectTopic(projectId: string) {
    const response = await this.client().send(new CreateTopicCommand({
      Name: `deployguard-${projectId.replace(/-/g, "").slice(0, 24)}-notifications`,
      Tags: [{ Key: "ManagedBy", Value: "DeployGuard" }, { Key: "DeployGuardProjectId", Value: projectId }],
    }));
    if (!response.TopicArn) throw new Error("Project notification topic could not be created.");
    return response.TopicArn;
  }
  private async deleteOwnedProjectTopic(projectId: string, topicArn: string) {
    let tags;
    try {
      tags = await this.client().send(new ListTagsForResourceCommand({ ResourceArn: topicArn }));
    } catch (error) {
      if ((error as { name?: string })?.name === "NotFoundException") return;
      throw error;
    }
    const ownership = Object.fromEntries((tags.Tags || []).filter((item) => item.Key && item.Value !== undefined).map((item) => [item.Key!, item.Value!]));
    if (ownership.ManagedBy !== "DeployGuard" || ownership.DeployGuardProjectId !== projectId) throw new Error("Project SNS topic ownership could not be proven.");
    await this.client().send(new DeleteTopicCommand({ TopicArn: topicArn }));
    try {
      await this.client().send(new GetTopicAttributesCommand({ TopicArn: topicArn }));
      throw new Error("Project SNS topic remains after deletion.");
    } catch (error) {
      if ((error as { name?: string })?.name !== "NotFoundException") throw error;
    }
  }
  private client() { return new SNSClient({ region: this.config.get<string>("SNS_REGION", this.config.get<string>("AWS_REGION", "us-east-1")) }); }
  private pending(arn: string | null | undefined) { return String(arn || "").replace(/[\s_]/g, "").toLowerCase() === "pendingconfirmation"; }
  private subscriptionAlreadyAbsentOrPending(error: unknown) {
    const value = error as { name?: unknown; message?: unknown };
    const name = String(value?.name || "");
    const message = String(value?.message || "");
    return ["NotFoundException", "ResourceNotFoundException"].includes(name)
      || (name === "InvalidParameterException" && /subscription.*pending confirmation|pending confirmation.*subscription/i.test(message));
  }
  private matchesFilter(policy: Record<string, unknown>, key: string, value: string) {
    return Array.isArray(policy[key]) && (policy[key] as unknown[]).map(String).includes(value);
  }
}
