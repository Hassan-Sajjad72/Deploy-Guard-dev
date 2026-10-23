import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createRedisConnection } from "../../projects/pipeline/redis.config";
import { InactiveV1InfrastructureApplyConsumerCompositionService } from "./inactive-v1-infrastructure-apply-consumer-composition.service";

@Injectable()
export class NormalV1InfrastructureApplyConsumerRuntimeService {
  private readonly logger = new Logger(NormalV1InfrastructureApplyConsumerRuntimeService.name);
  private session: any = null;
  constructor(private readonly config: ConfigService, private readonly composition: InactiveV1InfrastructureApplyConsumerCompositionService) {}
  async start() {
    const value = this.composition.getInactiveComposition();
    if (!value) return { state: "disabled", ready: false, safeCode: "NORMAL_V1_INFRASTRUCTURE_APPLY_CONSUMER_DISABLED" };
    this.session = await value.consumer.start({
      capability: { workerId: value.configuration.workerId, role: "infrastructure", supportedMessageTypes: ["intent.infrastructure.apply"], serviceVersion: "normal-v1-infrastructure-apply-consumer", gitSha: "local", heartbeatTtlMs: 60_000, metadata: { runtime: "normal-v1-infrastructure-apply-consumer" } },
      connection: createRedisConnection(this.config), prefix: this.config.get<string>("OUTBOX_BULLMQ_PREFIX", "bull"),
      scope: { projectIds: [value.configuration.projectId], environmentNames: ["dev"] }, exactMessageTypes: ["intent.infrastructure.apply"], concurrency: 1, leaseTtlMs: 60_000,
    });
    this.observe(); return { state: "ready", ready: true, safeCode: "NORMAL_V1_INFRASTRUCTURE_APPLY_CONSUMER_READY" };
  }
  observe() { const status = this.session ? this.composition.getInactiveComposition()?.consumer.getOperationalStatus() : null; this.logger.log(JSON.stringify({ state: status?.state || "stopped", ready: Boolean(status?.ready), safeCode: status?.lastOutcome?.safeCode || (status?.ready ? "NORMAL_V1_INFRASTRUCTURE_APPLY_CONSUMER_READY" : "NORMAL_V1_INFRASTRUCTURE_APPLY_CONSUMER_STOPPED") })); }
  async stop() { if (this.session) await this.session.stop(); this.session = null; this.observe(); }
}
