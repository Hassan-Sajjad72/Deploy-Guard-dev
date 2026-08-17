import { Job, Queue } from "bullmq";
import { DeployGuardWorkerEnvelopeV1 } from "../contracts/worker-envelope.types";
import { isFrozenBullMqJobId } from "./outbox-dispatcher.pure";

export const VERIFIED_BULLMQ_VERSION = "5.79.2";

export function assertFrozenBullMqAdapterCompatibility() {
  const installedVersion = (require("bullmq/package.json") as { version?: unknown }).version;
  if (installedVersion !== VERIFIED_BULLMQ_VERSION) {
    throw new Error(
      `Frozen BullMQ job-ID adapter requires bullmq ${VERIFIED_BULLMQ_VERSION}; installed ${String(installedVersion)}.`,
    );
  }
  return installedVersion;
}

class FrozenProtocolJob extends Job {
  protected validateOptions(jobData: unknown) {
    const jobId = this.opts.jobId;
    if (!jobId || !isFrozenBullMqJobId(jobId)) {
      throw new Error("Frozen BullMQ adapter requires a valid deterministic v1 job ID.");
    }
    this.opts.jobId = `dg:v1:${jobId.replaceAll(":", "_")}`;
    try {
      super.validateOptions(jobData as never);
    } finally {
      this.opts.jobId = jobId;
    }
  }
}

export class FrozenProtocolQueue extends Queue<DeployGuardWorkerEnvelopeV1> {
  constructor(...args: ConstructorParameters<typeof Queue>) {
    assertFrozenBullMqAdapterCompatibility();
    super(...args);
  }

  protected get Job(): typeof Job {
    return FrozenProtocolJob as typeof Job;
  }
}
