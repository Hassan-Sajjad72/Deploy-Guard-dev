import { Provider } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import { createRedisConnection } from "./redis.config";
import {
  PIPELINE_QUEUE,
  PIPELINE_QUEUE_NAME,
  PipelineJobData,
} from "./pipeline.types";

export const pipelineQueueProvider: Provider = {
  provide: PIPELINE_QUEUE,
  inject: [ConfigService],
  useFactory: (config: ConfigService) =>
    new Queue<PipelineJobData>(PIPELINE_QUEUE_NAME, {
      connection: createRedisConnection(config),
      defaultJobOptions: {
        removeOnComplete: { age: 86400, count: 100 },
        removeOnFail: { age: 604800, count: 250 },
      },
    }),
};
