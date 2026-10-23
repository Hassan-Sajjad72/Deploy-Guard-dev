import { ConnectionOptions } from "bullmq";
import {
  V1WorkerCapabilityIdentity,
} from "./inactive-v1-worker-runtime.types";

export type InactiveV1BullMqConsumerStartInput = {
  capability: V1WorkerCapabilityIdentity;
  connection: ConnectionOptions;
  prefix: string;
  concurrency?: number;
  leaseTtlMs?: number;
  leaseHeartbeatIntervalMs?: number;
  retryDelayMs?: number;
  heartbeatIntervalMs?: number;
};

export type InactiveV1BullMqConsumerFailureCode =
  | "CONSUMER_CAPABILITY_EXPIRED"
  | "CONSUMER_HEARTBEAT_FAILED"
  | "CONSUMER_LOOP_FAILED"
  | "CONSUMER_REDIS_ERROR";

export type InactiveV1BullMqConsumerSession = {
  readonly workerId: string;
  readonly queueNames: readonly string[];
  isActive(): boolean;
  lastFailureCode(): InactiveV1BullMqConsumerFailureCode | null;
  stop(): Promise<void>;
};

export class InactiveV1BullMqConsumerError extends Error {
  constructor(
    readonly code:
      | "CONSUMER_ALREADY_STARTED"
      | "CONSUMER_CONFIG_INVALID"
      | "CONSUMER_JOB_REJECTED"
      | "CONSUMER_RETRY_SCHEDULING_FAILED"
      | "CONSUMER_START_FAILED"
      | "CONSUMER_STOP_FAILED",
  ) {
    super(code);
    this.name = "InactiveV1BullMqConsumerError";
  }
}
