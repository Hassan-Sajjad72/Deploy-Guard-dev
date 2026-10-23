import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import Redis from "ioredis";

type DependencyStatus = {
  status: "up" | "down";
  latencyMs: number;
  error?: string;
};

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor(
    private readonly dataSource: DataSource,
    config: ConfigService,
  ) {
    this.redis = new Redis({
      host: config.get<string>("REDIS_HOST", "localhost"),
      port: Number(config.get<string>("REDIS_PORT", "6379")),
      password: config.get<string>("REDIS_PASSWORD") || undefined,
      tls: config.get<string>("REDIS_TLS", "false") === "true" ? {} : undefined,
      connectTimeout: 1_500,
      commandTimeout: 1_500,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    this.redis.on("error", () => undefined);
  }

  live() {
    return {
      status: "up" as const,
      service: "deployguard-api",
      timestamp: new Date().toISOString(),
    };
  }

  async ready() {
    const [database, redis, outbox] = await Promise.all([
      this.check("database", async () => {
        if (!this.dataSource.isInitialized) {
          throw new Error("not_initialized");
        }
        await this.dataSource.query("SELECT 1");
      }),
      this.check("redis", async () => {
        const result = await this.redis.ping();
        if (result !== "PONG") {
          throw new Error("unexpected_response");
        }
      }),
      this.check("outbox", async () => {
        const [snapshot] = await this.dataSource.query(
          `SELECT
             count(*) FILTER (WHERE status = 'pending')::integer AS pending,
             count(*) FILTER (WHERE status = 'failed')::integer AS failed,
             count(*) FILTER (WHERE status = 'publishing')::integer AS publishing,
             count(*) FILTER (
               WHERE status = 'dead_letter'
                 AND (
                   last_error IS NULL
                   OR last_error NOT IN (
                     'INTENT_COMPLETED_BEFORE_OUTBOX_DISPATCH',
                     'INTENT_FAILED_BEFORE_OUTBOX_DISPATCH',
                     'INTENT_CANCELLED_BEFORE_OUTBOX_DISPATCH',
                     'INTENT_NO_OP_BEFORE_OUTBOX_DISPATCH',
                     'INTENT_REJECTED_BEFORE_OUTBOX_DISPATCH',
                     'INTENT_CANCELLED_BEFORE_DISPATCH'
                   )
                 )
             )::integer AS actionable
           FROM orchestration_outbox`,
        );
        const blocked = Number(snapshot?.pending || 0)
          + Number(snapshot?.failed || 0)
          + Number(snapshot?.publishing || 0)
          + Number(snapshot?.actionable || 0);
        if (blocked > 0) throw new Error("delivery_backlog_present");
      }),
    ]);

    return {
      status: database.status === "up" && redis.status === "up" && outbox.status === "up"
        ? "ready" as const
        : "not_ready" as const,
      service: "deployguard-api",
      dependencies: { database, redis, outbox },
      timestamp: new Date().toISOString(),
    };
  }

  async onModuleDestroy() {
    if (this.redis.status === "wait") {
      this.redis.disconnect();
      return;
    }
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }

  private async check(_name: string, operation: () => Promise<void>): Promise<DependencyStatus> {
    const started = Date.now();
    try {
      await operation();
      return { status: "up", latencyMs: Date.now() - started };
    } catch (error) {
      return {
        status: "down",
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : "unknown_error",
      };
    }
  }
}
