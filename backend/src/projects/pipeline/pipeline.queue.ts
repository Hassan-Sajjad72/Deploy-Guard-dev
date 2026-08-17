import { OnModuleDestroy, Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue, QueueOptions } from "bullmq";
import { createRedisConnection } from "./redis.config";
import {
  PIPELINE_QUEUE,
  PIPELINE_QUEUE_NAME,
  PipelineJobData,
} from "./pipeline.types";

export class NestManagedQueue<T> extends Queue<T> implements OnModuleDestroy {
  constructor(name: string, options: QueueOptions) {
    super(name, options);
  }

  async onModuleDestroy() {
    await this.close();
  }
}

export const pipelineQueueProvider: Provider = {
  provide: PIPELINE_QUEUE,
  inject: [ConfigService],
  useFactory: (config: ConfigService) =>
    new NestManagedQueue<PipelineJobData>(PIPELINE_QUEUE_NAME, {
      connection: createRedisConnection(config),
      defaultJobOptions: {
        removeOnComplete: { age: 86400, count: 100 },
        removeOnFail: { age: 604800, count: 250 },
      },
    }),
};
