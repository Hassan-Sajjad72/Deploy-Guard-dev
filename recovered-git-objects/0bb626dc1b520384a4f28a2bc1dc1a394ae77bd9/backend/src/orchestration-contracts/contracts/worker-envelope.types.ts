import { ExecutionLane } from "./deployment-intent.types";

export const WORKER_MESSAGE_TYPES = [
  "intent.release.execute",
  "intent.infrastructure.plan",
  "intent.infrastructure.apply",
  "intent.deletion.execute",
  "outbox.reconcile",
] as const;

export type WorkerMessageType = typeof WORKER_MESSAGE_TYPES[number];

export type DeployGuardWorkerEnvelopeV1 = {
  protocol: {
    name: "deployguard.worker";
    schemaVersion: 1;
    messageType: WorkerMessageType;
    minimumWorkerProtocol: 1;
    maximumWorkerProtocol: 1;
  };
  producer: {
    service: "deployguard-api" | "deployguard-outbox-dispatcher";
    serviceVersion: string;
    gitSha: string;
    producedAt: string;
  };
  identity: {
    intentId: string;
    projectId: string;
    environmentName: string;
    pipelineRunId: string | null;
    destroyOperationId: string | null;
    infrastructureManifestId: string | null;
    releaseManifestId: string | null;
  };
  routing: {
    lane: ExecutionLane;
    operation: "execute" | "plan" | "apply" | "destroy";
    queue: string;
  };
  idempotency: {
    canonicalKey: string;
    payloadSha256: string;
    attempt: number;
    replayOfJobId: string | null;
  };
  execution: {
    mode: "full" | "resume";
    resumeFromStage: string | null;
    reusableCheckpointIds: string[];
    invalidatedCheckpointIds: string[];
    reasonCodes: string[];
    fencingTokenRequired: boolean;
  };
  trace: {
    correlationId: string;
    causationId: string | null;
    actorUserId: number | null;
  };
  expiresAt: string;
};

