import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Job, Queue } from "bullmq";
import { createRedisConnection } from "../../projects/pipeline/redis.config";
import { DeployGuardWorkerEnvelopeV1 } from "../contracts/worker-envelope.types";
import { workerEnvelopeJobId } from "../contracts/worker-envelope.validator";
import { assertFrozenQueueRouting, isFrozenBullMqJobId } from "./outbox-dispatcher.pure";
import { OutboxJobPublisher } from "./outbox-dispatcher.types";

class FrozenProtocolJob extends Job {
  protected validateOptions(jobData: unknown) {
    const jobId = this.opts.jobId;
    if (!jobId || !isFrozenBullMqJobId(jobId)) {
      return super.validateOptions(jobData as never);
    }
    this.opts.jobId = `dg:v1:${jobId.replaceAll(":", "_")}`;
    try {
      super.validateOptions(jobData as never);
    } finally {
      this.opts.jobId = jobId;
    }
  }
}

class FrozenProtocolQueue extends Queue<DeployGuardWorkerEnvelopeV1> {
  protected get Job(): typeof Job {
    return FrozenProtocolJob as typeof Job;
  }
}

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
    const queue = new FrozenProtocolQueue(name, {
      connection: createRedisConnection(this.config),
      prefix,
      skipMetasUpdate: false,
    });
    this.queues.set(name, queue);
    return queue;
  }
}
