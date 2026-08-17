import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createRedisConnection } from "../../projects/pipeline/redis.config";
import { DeployGuardWorkerEnvelopeV1 } from "../contracts/worker-envelope.types";
import { workerEnvelopeJobId } from "../contracts/worker-envelope.validator";
import { FrozenProtocolQueue } from "./frozen-bullmq-job.adapter";
import { assertFrozenQueueRouting, isFrozenBullMqJobId } from "./outbox-dispatcher.pure";
import { OutboxJobPublisher } from "./outbox-dispatcher.types";

@Injectable()
export class BullMqOutboxPublisher implements OutboxJobPublisher, OnModuleDestroy {
  private readonly queues = new Map<string, FrozenProtocolQueue>();

  constructor(private readonly config: ConfigService) {}

  async publish(envelope: DeployGuardWorkerEnvelopeV1, deterministicJobId: string) {
    const queueName = assertFrozenQueueRouting(envelope);
    if (deterministicJobId !== workerEnvelopeJobId(envelope) || !isFrozenBullMqJobId(deterministicJobId)) {
      throw new Error("BullMQ job ID does not match the frozen worker-envelope identity.");
    }
    const queue = this.queue(queueName);
    const job = await queue.add(
      envelope.protocol.messageType,
      envelope,
      {
        jobId: deterministicJobId,
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
      },
    );
    if (job.id !== deterministicJobId) {
      throw new Error("BullMQ returned an unexpected job ID.");
    }
    return { jobId: deterministicJobId };
  }

  async onModuleDestroy() {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
  }

  private queue(name: string) {
    const existing = this.queues.get(name);
    if (existing) return existing;
    const prefix = this.config.get<string>("OUTBOX_BULLMQ_PREFIX", "bull");
    // API publication must fail back to PostgreSQL's durable retry state when
    // Redis is unavailable. Worker connections intentionally retry forever;
    // a producer must not leave the lifecycle drain hung in Queue.add().
    const connection = {
      ...createRedisConnection(this.config),
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    };
    const queue = new FrozenProtocolQueue(name, {
      connection,
      prefix,
      skipMetasUpdate: false,
    });
    this.queues.set(name, queue);
    return queue;
  }
}
