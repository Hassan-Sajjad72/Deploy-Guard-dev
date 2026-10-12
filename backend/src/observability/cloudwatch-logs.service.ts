import { HttpException, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { Response } from "express";
import { User } from "../users/user.entity";
import { getObservabilityConfig } from "./observability.config";
import { AwsRuntimeUnavailableException, LiveRuntimeIdentity, LiveRuntimeResolverService, RuntimeIdentityUnavailableException } from "./live-runtime-resolver.service";
import { LogSanitizerService } from "./log-sanitizer.service";

export type LogQueryOptions = { since?: string; limit?: number };
export type RuntimeLogEvent = { id: string; timestamp: string; source: string; message: string };

@Injectable()
export class CloudWatchLogsService {
  constructor(
    private readonly config: ConfigService,
    private readonly liveRuntime: LiveRuntimeResolverService,
    private readonly sanitizer: LogSanitizerService,
  ) {}

  async getRecentLogs(user: User, projectId: string, options: LogQueryOptions = {}, serviceId?: string) {
    const identity = await this.liveRuntime.resolveForUser(user, projectId, serviceId);
    const config = getObservabilityConfig(this.config);
    if (!config.awsRuntimeMonitoringEnabled || !config.cloudWatchLogsEnabled) {
      return this.unavailable(identity, "CloudWatch log monitoring is disabled.");
    }
    const limit = Math.min(Math.max(Number(options.limit || config.logHistoryMaxEvents), 1), config.logHistoryMaxEvents);
    const since = options.since ? Date.parse(options.since) : Date.now() - config.logHistoryMinutes * 60_000;
    try {
      return {
        available: true,
        message: null,
        projectId,
        environmentName: identity.environmentName,
        generationId: identity.generationId,
        serviceId: identity.serviceId,
        serviceName: identity.serviceDisplayName,
        logGroupName: identity.logGroupName,
        events: await this.fetch(identity, Number.isFinite(since) ? since : Date.now() - config.logHistoryMinutes * 60_000, limit),
      };
    } catch (error) {
      if (this.isMissing(error)) return this.unavailable(identity, "The LIVE task has not produced CloudWatch logs yet.");
      throw error;
    }
  }

  async stream(user: User, projectId: string, response: Response, serviceId?: string, refreshUser?: () => Promise<User | null>) {
    const config = getObservabilityConfig(this.config);
    const authorize = async () => {
      const actor = await refreshUser?.();
      if (!actor || actor.disabledAt || actor.id !== user.id) throw new UnauthorizedException("Log stream access expired.");
      return this.liveRuntime.resolveForUser(actor, projectId, serviceId);
    };
    await authorize();
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders?.();
    response.write(`retry: ${config.logReconnectMilliseconds}\n\n`);

    let closed = false;
    response.on("close", () => { closed = true; });
    let identity: LiveRuntimeIdentity | null = null;
    let cursor = Date.now() - config.logHistoryMinutes * 60_000;
    let heartbeatAt = 0;
    let consecutiveErrors = 0;
    const send = (event: string, data: unknown, id?: string) => {
      if (closed) return;
      const frame = `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      if (Number(response.writableLength || 0) + Buffer.byteLength(frame) > 4 * 1024 * 1024) { closed = true; response.end(); return; }
      response.write(frame);
    };

    try {
      while (!closed) {
        try {
          const resolved = await authorize();
          const identityChanged = Boolean(identity && (identity.generationId !== resolved.generationId || identity.serviceId !== resolved.serviceId));
          if (!identity || identityChanged) {
            identity = resolved;
            cursor = Date.now() - config.logHistoryMinutes * 60_000;
            const history = config.cloudWatchLogsEnabled
              ? await this.fetch(identity, cursor, config.logHistoryMaxEvents).catch((error) => this.isMissing(error) ? [] : Promise.reject(error))
              : [];
            const current = await authorize();
            if (current.generationId !== identity.generationId || current.serviceId !== identity.serviceId) { identity = null; continue; }
            if (history.length) cursor = Math.max(...history.map((event) => Date.parse(event.timestamp))) + 1;
            send(identityChanged ? "generation_changed" : "connected", {
              projectId,
              environmentName: identity.environmentName,
              generationId: identity.generationId,
              serviceId: identity.serviceId,
              serviceName: identity.serviceDisplayName,
              logGroupName: identity.logGroupName,
              taskCount: identity.taskArns.length,
              history,
            });
          } else if (config.cloudWatchLogsEnabled) {
            const events = await this.fetch(identity, cursor, config.logStreamMaxEvents);
            const current = await authorize();
            if (current.generationId !== identity.generationId || current.serviceId !== identity.serviceId) { identity = null; continue; }
            for (const event of events) {
              send("log", event, event.id);
              cursor = Math.max(cursor, Date.parse(event.timestamp) + 1);
            }
          }
          consecutiveErrors = 0;
          if (Date.now() - heartbeatAt >= config.logStreamHeartbeatSeconds * 1_000) {
            send("heartbeat", { timestamp: new Date().toISOString(), generationId: identity.generationId });
            heartbeatAt = Date.now();
          }
          await this.sleep(config.logStreamPollIntervalSeconds * 1_000);
        } catch (error) {
          try { const actor = await refreshUser?.(); if (!actor || actor.disabledAt || actor.id !== user.id) throw new UnauthorizedException(); await this.liveRuntime.assertAccessForUser(actor, projectId); }
          catch (accessError) { error = accessError instanceof HttpException && [401, 403, 404].includes(accessError.getStatus()) ? accessError : new UnauthorizedException("Log stream authority is unavailable."); }
          if (error instanceof HttpException && [401, 403, 404].includes(error.getStatus())) {
            send("access_revoked", { message: "Log stream access ended. Sign in and confirm project access before reconnecting." });
            response.end(); closed = true; break;
          }
          consecutiveErrors += 1;
          send("warning", {
            timestamp: new Date().toISOString(),
            message: this.safeError(error),
            retrying: true,
            generationId: identity?.generationId || null,
          });
          await this.sleep(Math.min(config.logReconnectMilliseconds * consecutiveErrors, 30_000));
        }
      }
    } finally {
      if (!closed) response.end();
    }
  }

  private async fetch(identity: LiveRuntimeIdentity, startTime: number, limit: number): Promise<RuntimeLogEvent[]> {
    const query = async (context: { region: string; credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken: string } }) => {
      const client = context.credentials ? new CloudWatchLogsClient({ ...context, maxAttempts: 1 }) : this.client(context.region);
      try { return await client.send(new FilterLogEventsCommand({
      logGroupName: identity.logGroupName,
      startTime,
      interleaved: true,
      limit,
      }), { abortSignal: AbortSignal.timeout(15_000) }); } finally { client.destroy(); }
    };
    const response = await this.liveRuntime.withRuntimeRead(identity, query);
    return (response.events || []).flatMap((event, index) => {
      if (!event.timestamp) return [];
      const source = String(event.logStreamName || `${identity.logStreamPrefix}/${identity.containerName}`);
      const id = this.sanitizer.sanitize(String(event.eventId || `${event.timestamp}-${index}`));
      return [{
        id,
        timestamp: new Date(event.timestamp).toISOString(),
        source: this.sanitizer.sanitize(source).slice(0, 512),
        message: this.sanitizer.sanitize(event.message || "").slice(0, 10_000),
      }];
    }).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  private unavailable(identity: LiveRuntimeIdentity, message: string) {
    return { available: false, message, projectId: identity.projectId, environmentName: identity.environmentName, generationId: identity.generationId, serviceId: identity.serviceId, serviceName: identity.serviceDisplayName, logGroupName: identity.logGroupName, events: [] as RuntimeLogEvent[] };
  }
  private client(region: string) { return new CloudWatchLogsClient({ region }); }
  private sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
  private isMissing(error: unknown) { return ["ResourceNotFoundException", "ResourceNotFound"].includes(String((error as { name?: string })?.name || "")); }
  private safeError(error: unknown) {
    if (error instanceof RuntimeIdentityUnavailableException) return "The authoritative runtime identity is unavailable; CloudWatch Logs was not queried.";
    if (error instanceof AwsRuntimeUnavailableException) return "AWS ECS/ALB runtime observation is temporarily unavailable; CloudWatch Logs was not queried.";
    const name = String((error as { name?: string })?.name || "CloudWatchLogsUnavailable");
    return this.sanitizer.sanitize(`CloudWatch log streaming is temporarily unavailable (${name}).`);
  }
}
