import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";

type DependencyStatus = {
  status: "up" | "down";
  latencyMs: number;
  error?: string;
};

@Injectable()
export class HealthService {
  constructor(private readonly dataSource: DataSource) {}

  live() {
    return {
      status: "up" as const,
      service: "deployguard-api",
      timestamp: new Date().toISOString(),
    };
  }

  async ready() {
    const database = await this.check("database", async () => {
      if (!this.dataSource.isInitialized) {
        throw new Error("not_initialized");
      }
      await this.dataSource.query("SELECT 1");
    });

    return {
      status: database.status === "up" ? "ready" as const : "not_ready" as const,
      service: "deployguard-api",
      dependencies: { database },
      timestamp: new Date().toISOString(),
    };
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
