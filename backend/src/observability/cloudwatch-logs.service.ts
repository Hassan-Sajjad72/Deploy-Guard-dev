import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import {
  CloudWatchLogsClient,
  DescribeLogStreamsCommand,
  FilterLogEventsCommand,
  GetLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { Response } from "express";
import { Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { ProjectDeployment } from "../orchestration/project-deployment.entity";
import { User } from "../users/user.entity";
import { getObservabilityConfig } from "./observability.config";
import { LogSanitizerService } from "./log-sanitizer.service";
import {
  LogStreamSessionStatus,
  ProjectLogStreamSession,
} from "./project-log-stream-session.entity";

export type LogQueryOptions = {
  pipelineRunId?: string;
  deploymentId?: string;
  taskId?: string;
  logGroupName?: string;
  logStreamName?: string;
  since?: string;
  stream?: "stdout" | "stderr" | "all";
  limit?: number;
};

@Injectable()
export class CloudWatchLogsService {
  constructor(
    @InjectRepository(ProjectDeployment)
    private readonly deploymentRepository: Repository<ProjectDeployment>,
    @InjectRepository(ProjectLogStreamSession)
    private readonly sessionRepository: Repository<ProjectLogStreamSession>,
    private readonly config: ConfigService,
    private readonly sanitizer: LogSanitizerService,
    private readonly auditLogService: AuditLogService
  ) {}

  async resolveLogGroupForProject(projectId: string, deploymentId?: string) {
    const deployment = await this.findDeployment(projectId, deploymentId);
    const metadata = deployment?.metadata || {};
    return String(
      metadata.logGroupName ||
      metadata.cloudWatchLogGroupName ||
      this.config.get<string>("CLOUDWATCH_LOG_GROUP_NAME", "") ||
      `/ecs/deployguard/${projectId}`
    );
  }

  async resolveLogStreams(projectId: string, deploymentId?: string, taskId?: string, logGroupName?: string) {
    const groupName = logGroupName || await this.resolveLogGroupForProject(projectId, deploymentId);
    const response = await this.client().send(
      new DescribeLogStreamsCommand({
        logGroupName: groupName,
        descending: true,
        orderBy: "LastEventTime",
        logStreamNamePrefix: taskId,
        limit: 20,
      })
    );

    return (response.logStreams || []).map((stream) => stream.logStreamName).filter(Boolean) as string[];
  }

  async fetchLogEvents(logGroupName: string, logStreamName?: string, nextToken?: string, limit = 100, startTime?: number) {
    if (logStreamName) {
      const response = await this.client().send(
        new GetLogEventsCommand({
          logGroupName,
          logStreamName,
          nextToken,
          startTime,
          limit,
          startFromHead: false,
        })
      );
      return {
        events: (response.events || []).map((event) => this.sanitizeLogEvent(event, logStreamName)),
        nextToken: response.nextForwardToken,
      };
    }

    const response = await this.client().send(
      new FilterLogEventsCommand({
        logGroupName,
        startTime,
        limit,
        nextToken,
      })
    );
    return {
      events: (response.events || []).map((event) => this.sanitizeLogEvent(event, event.logStreamName || null)),
      nextToken: response.nextToken,
    };
  }

  sanitizeLogEvent(event: { timestamp?: number; message?: string; logStreamName?: string | null }, logStreamName?: string | null) {
    return {
      timestamp: event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString(),
      message: this.sanitizer.sanitize(event.message || ""),
      logStreamName: this.sanitizer.sanitize(logStreamName || event.logStreamName || ""),
    };
  }

  async getRecentLogs(projectId: string, options: LogQueryOptions) {
    const config = getObservabilityConfig(this.config);

    if (!config.cloudWatchLogsEnabled) {
      return { enabled: false, message: "CloudWatch Logs are disabled.", events: [] };
    }

    const logGroupName = options.logGroupName || await this.resolveLogGroupForProject(projectId, options.deploymentId);
    const streams = options.logStreamName
      ? [options.logStreamName]
      : await this.resolveLogStreams(projectId, options.deploymentId, options.taskId, logGroupName).catch(() => []);
    const streamName = streams[0] || undefined;
    const limit = Math.min(Number(options.limit || config.logStreamMaxEvents), config.logStreamMaxEvents);
    const startTime = options.since ? new Date(options.since).getTime() : undefined;
    const result = await this.fetchLogEvents(logGroupName, streamName, undefined, limit, startTime);

    return {
      enabled: true,
      logGroupName: this.sanitizer.sanitize(logGroupName),
      logStreamName: this.sanitizer.sanitize(streamName || ""),
      events: result.events,
      nextToken: result.nextToken,
    };
  }

  async streamLogsToSse(projectId: string, options: LogQueryOptions, response: Response, actorUser?: User | null) {
    const config = getObservabilityConfig(this.config);
    const session = await this.sessionRepository.save(
      this.sessionRepository.create({
        projectId,
        pipelineRunId: options.pipelineRunId || null,
        deploymentId: options.deploymentId || null,
        userId: actorUser?.id || null,
        status: LogStreamSessionStatus.STARTED,
        source: "cloudwatch_logs",
        startedAt: new Date(),
        metadata: this.sanitizer.sanitizeMetadata({ stream: options.stream || "all", limit: options.limit }),
      })
    );

    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders?.();

    const send = (event: string, data: Record<string, unknown>) => {
      response.write(`event: ${event}\n`);
      response.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    let stopped = false;
    response.on("close", () => {
      stopped = true;
    });

    try {
      if (!config.cloudWatchLogsEnabled) {
        send("error", { message: "CloudWatch Logs are disabled." });
        return;
      }

      const logGroupName = options.logGroupName || await this.resolveLogGroupForProject(projectId, options.deploymentId);
      const streams = options.logStreamName
        ? [options.logStreamName]
        : await this.resolveLogStreams(projectId, options.deploymentId, options.taskId, logGroupName);
      const logStreamName = streams[0];
      let nextToken: string | undefined;

      session.status = LogStreamSessionStatus.ACTIVE;
      session.logGroupName = this.sanitizer.sanitize(logGroupName);
      session.logStreamName = this.sanitizer.sanitize(logStreamName || "");
      await this.sessionRepository.save(session);
      await this.auditLogService.record({
        actorUser,
        action: "LOG_STREAM_STARTED",
        resourceType: "observability",
        resourceId: projectId,
        status: "success",
        metadata: this.sanitizer.sanitizeMetadata({ projectId, deploymentId: options.deploymentId, logGroupName, logStreamName }),
      });

      send("connected", { sessionId: session.id, logGroupName: session.logGroupName, logStreamName: session.logStreamName });

      while (!stopped) {
        const result = await this.fetchLogEvents(logGroupName, logStreamName, nextToken, config.logStreamMaxEvents);
        nextToken = result.nextToken;

        for (const event of result.events) {
          send("log_line", event);
        }

        send("heartbeat", { timestamp: new Date().toISOString() });
        await this.sleep(config.logStreamPollIntervalSeconds * 1000);
      }

      send("completed", { sessionId: session.id });
      session.status = LogStreamSessionStatus.STOPPED;
      session.stoppedAt = new Date();
      await this.sessionRepository.save(session);
      await this.auditLogService.record({
        actorUser,
        action: "LOG_STREAM_STOPPED",
        resourceType: "observability",
        resourceId: projectId,
        status: "success",
        metadata: this.sanitizer.sanitizeMetadata({ projectId, deploymentId: options.deploymentId }),
      });
    } catch (error) {
      const message = this.failureMessage(error, "CloudWatch log stream failed.");
      send("error", { message });
      session.status = LogStreamSessionStatus.FAILED;
      session.errorMessage = message;
      session.stoppedAt = new Date();
      await this.sessionRepository.save(session);
      await this.auditLogService.record({
        actorUser,
        action: "LOG_STREAM_FAILED",
        resourceType: "observability",
        resourceId: projectId,
        status: "failed",
        metadata: this.sanitizer.sanitizeMetadata({ projectId, deploymentId: options.deploymentId, reason: message }),
      });
    } finally {
      response.end();
    }
  }

  private findDeployment(projectId: string, deploymentId?: string) {
    return this.deploymentRepository.findOne({
      where: { projectId, ...(deploymentId ? { id: deploymentId } : {}) },
      order: { createdAt: "DESC" },
    });
  }

  private client() {
    return new CloudWatchLogsClient({ region: this.config.get<string>("AWS_REGION", "us-east-1") });
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private failureMessage(error: unknown, fallback: string) {
    if (!error || typeof error !== "object") {
      return fallback;
    }

    const awsError = error as { name?: string };
    return awsError.name ? `${fallback} ${awsError.name}` : fallback;
  }
}
